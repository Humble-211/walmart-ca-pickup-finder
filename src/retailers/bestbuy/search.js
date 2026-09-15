// Best Buy answers pickup availability for up to LOCATIONS_PER_CALL stores per call,
// so the nationwide search is a nearest-first sweep over the store catalog in a
// handful of batches, stopping at the first batch that contains stock.
import { haversineKm, locateUser } from "../../lib/geo.js";

const PRODUCT_URL = (sku) => `https://www.bestbuy.ca/en-ca/product/${sku}`;
const NEVER_IN_STORE = new Set(["OnlineOnly", "NotAvailable"]);

// api: { LOCATIONS_PER_CALL, getAvailability(sku, ids) -> { aggregate, statuses } }
// catalog: [{ id, name, address, postalCode, lat, lon }] — every store in Canada.
// productUrl: the canonical product page URL to attach to far-store results;
// falls back to the slug-less form when not given.
export async function findNearestInStock({ sku, nearby, checkedIds = [], onProgress, api, catalog, gapMs = 0, productUrl }) {
  const url = productUrl || PRODUCT_URL(sku);
  const coords = new Map(catalog.map((s) => [s.id, s]));
  const inStock = nearby.filter((s) => s.status === "available");
  const checked = new Set([...nearby.map((s) => s.id), ...checkedIds]);
  const done = (complete, rateLimited = false) => ({
    inStock: inStock.sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity)),
    searched: checked.size, checkedIds: [...checked], complete, rateLimited,
  });
  if (inStock.length) return done(true);
  const user = locateUser(nearby, coords);
  if (!user) return { ...done(false), noLocation: true };

  const todo = catalog
    .filter((s) => !checked.has(s.id))
    .map((s) => ({ s, km: haversineKm(user, s) }))
    .sort((a, b) => a.km - b.km);
  for (let i = 0; i < todo.length; i += api.LOCATIONS_PER_CALL) {
    const batch = todo.slice(i, i + api.LOCATIONS_PER_CALL);
    let result;
    try {
      if (gapMs && i) await new Promise((r) => setTimeout(r, gapMs));
      result = await api.getAvailability(sku, batch.map(({ s }) => s.id));
    } catch (err) {
      if (err?.code === "rate_limited") return done(false, true);
      throw err;
    }
    for (const { s, km } of batch) {
      checked.add(s.id); // ids the service does not carry are absent from the response: unknown, but checked
      if (result.statuses.get(s.id) === "available") {
        inStock.push({ id: s.id, name: s.name, address: s.address, postalCode: s.postalCode, distanceKm: km, status: "available", url });
      }
    }
    onProgress?.({ calls: i / api.LOCATIONS_PER_CALL + 1, searched: checked.size, remaining: todo.length - i - batch.length });
    if (inStock.length || NEVER_IN_STORE.has(result.aggregate)) break;
  }
  return done(true);
}
