// Staples returns the 5 nearest pickup stores within ~90 km of a postal code and
// accepts no store list, so the nationwide search is walmart's outward prober with
// a 5-store / 90 km probe shape, each probe seeded with a catalog store's postal code.
import { findNearestInStock } from "../../lib/stock-search.js";
import { locateUser } from "../../lib/geo.js";

export const SEARCH_MAX_CALLS = 40;
export const SEARCH_GAP_MS = 1000;
const PROBE = { maxCount: 5, radiusKm: 90, centroids: false };

// The availability response has no store name, so the parser falls back to "Staples <city>".
// Replace it with the catalog's real name (e.g. "Staples Toronto - Leaside") when the store's
// id is known; keep the parsed fallback otherwise. `catalogById` is a Map<id, {name, ...}>,
// built once by the caller (see content.js) so both the lookup and findInStock paths join
// against the same catalog without rebuilding the map per call.
export function withCatalogNames(stores, catalogById) {
  return stores.map((s) => {
    const c = catalogById.get(s.id);
    return c ? { ...s, name: c.name } : s;
  });
}

export async function searchInStock({ sku, nearby, checkedIds = [], onProgress, api, catalog, productUrl, gapMs = SEARCH_GAP_MS, maxCalls = SEARCH_MAX_CALLS, exhaustive = false }) {
  const coords = new Map(catalog.map((s) => [s.id, s]));
  const user = locateUser(nearby, coords);
  const withUrl = (s) => ({ ...s, url: productUrl });
  if (!user) {
    return { inStock: nearby.filter((s) => s.status === "available").map(withUrl), searched: nearby.length, checkedIds: nearby.map((s) => s.id), calls: 0, complete: false, rateLimited: false, noLocation: true };
  }
  const known = new Set(nearby.map((s) => s.id));
  const seed = [...nearby, ...checkedIds.filter((id) => !known.has(id)).map((id) => ({ id, status: "unknown", distanceKm: null }))];
  const result = await findNearestInStock({
    nearby: seed, user, catalog, onProgress, maxCalls, gapMs, probe: PROBE, exhaustive,
    fetchAround: (_lat, _lon, centre) => api.getAvailability(sku, centre.postalCode),
  });
  // Staples answers five stores per call, so what is left to do is always covering the
  // rest of its 302, never finding something closer. It therefore calls itself finished
  // only when nothing is unchecked, which is what keeps "Keep searching farther" on
  // screen after a fast first pass that happened to find stock next door.
  return {
    ...result,
    inStock: result.inStock.map(withUrl),
    exhaustive: true,
    complete: !result.rateLimited && result.remaining === 0,
  };
}
