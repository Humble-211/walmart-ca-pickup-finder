// Shoppers' store endpoint returns the 10 nearest stores within ~20 km of a point and
// accepts no store list, so the nationwide search is walmart's outward prober with a
// 10-store / 20 km probe shape. Each probe asks for stores WITH stock only: a response
// with fewer than 10 hits proves nothing else within 20 km has stock, and a full one
// proves it for everything nearer than its farthest hit, so a probe covers far more
// than the 10 stores it names (coveredKm in lib/stock-search.js).
import { findNearestInStock } from "../../lib/stock-search.js";

export const SEARCH_MAX_CALLS = 40;
export const SEARCH_GAP_MS = 1000;
export const PROBE = { maxCount: 10, radiusKm: 20, centroids: true };

export async function searchInStock({ code, user, nearby, checkedIds = [], onProgress, api, catalog, productUrl, gapMs = SEARCH_GAP_MS, maxCalls = SEARCH_MAX_CALLS }) {
  const withUrl = (s) => ({ ...s, url: productUrl });
  if (!user) {
    return { inStock: nearby.filter((s) => s.status === "available").map(withUrl), searched: nearby.length, checkedIds: nearby.map((s) => s.id), calls: 0, complete: false, rateLimited: false, noLocation: true };
  }
  const known = new Set(nearby.map((s) => s.id));
  const seed = [...nearby, ...checkedIds.filter((id) => !known.has(id)).map((id) => ({ id, status: "unknown", distanceKm: null }))];
  const result = await findNearestInStock({
    nearby: seed, user, catalog, onProgress, maxCalls, gapMs, probe: PROBE,
    fetchAround: async (lat, lon) => {
      const stores = await api.getStoreStock(code, { lat, lon }, true);
      const far = stores.reduce((m, s) => Math.max(m, s.distanceKm ?? 0), 0);
      return { stores, coveredKm: stores.length < PROBE.maxCount ? PROBE.radiusKm : far };
    },
  });
  return { ...result, inStock: result.inStock.map(withUrl) };
}
