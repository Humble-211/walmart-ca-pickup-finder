// Nearest-first search for stores that have an item in stock, beyond the handful
// a retailer returns around a postal code. Each API call returns at most a
// capped number of stores nearest a point within a capped radius, so we probe
// outward from the user, placing each probe where its response would contain
// the most not-yet-checked stores, until the nearest in-stock store is certain
// or the call budget is spent. The probe shape is configurable: walmart uses
// 50 stores within 100 km with centroid candidates (the default); staples uses
// 5 stores within ~90 km, seeded only from catalog stores (no centroids); shoppers
// uses 10 stores within ~20 km and asks for in-stock stores only, reporting how far
// each response is known to cover (see fetchAround below).
import { haversineKm } from "./geo.js";

export const DEFAULT_PROBE = { maxCount: 50, radiusKm: 100, centroids: true };
// Kept as aliases of the defaults for existing imports.
export const PROBE_MAX_COUNT = DEFAULT_PROBE.maxCount;
export const PROBE_RADIUS_KM = DEFAULT_PROBE.radiusKm;
const CANDIDATES = 12;

// What a probe at `centre` would return: the nearest catalog stores within the radius, capped.
function simulateProbe(centre, catalog, probe) {
  return catalog
    .map((s) => ({ s, d: haversineKm(centre, s) }))
    .filter(({ d }) => d <= probe.radiusKm)
    .sort((a, b) => a.d - b.d)
    .slice(0, probe.maxCount)
    .map(({ s }) => s);
}

// uncovered: [{id, lat, lon, userKm, ...}] sorted by userKm; catalog: every known store.
// Candidates are the nearest uncovered stores and, unless probe.centroids is false, for
// each also the centroid of the uncovered stores within probe range of it (which pulls
// the centre into the unchecked mass). The winner is the candidate whose simulated
// response includes the nearest uncovered store (so the search stays nearest-first) and
// holds the most uncovered stores; ties go to the earlier, nearer candidate.
export function planProbe(uncovered, catalog = uncovered, probe = DEFAULT_PROBE) {
  const p = { ...DEFAULT_PROBE, ...probe };
  const uncoveredIds = new Set(uncovered.map((s) => s.id));
  const target = uncovered[0];
  const seeds = uncovered.slice(0, CANDIDATES);
  const candidates = [...seeds];
  if (p.centroids) {
    for (const c of seeds) {
      const near = uncovered.filter((s) => haversineKm(c, s) <= p.radiusKm);
      candidates.push({ id: null, lat: near.reduce((a, s) => a + s.lat, 0) / near.length, lon: near.reduce((a, s) => a + s.lon, 0) / near.length });
    }
  }
  let best = null, bestKey = [-1, -1];
  for (const c of candidates) {
    const response = simulateProbe(c, catalog, p);
    const key = [response.some((s) => s.id === target.id) ? 1 : 0, response.filter((s) => uncoveredIds.has(s.id)).length];
    if (key[0] > bestKey[0] || (key[0] === bestKey[0] && key[1] > bestKey[1])) { best = c; bestKey = key; }
  }
  return best;
}

// fetchAround(lat, lon, centre) returns the stores the retailer reports around the centre,
// either as an array or as { stores, coveredKm }. With coveredKm, every catalog store within
// that distance of the centre counts as checked even when the response omits it (a
// "stores with stock only" query covers everything nearer than its farthest hit).
// `exhaustive` drops the nearest-only stop: instead of finishing once nothing
// unchecked could be closer than the best hit so far, the sweep runs until the whole
// catalogue is covered or the call budget runs out. It is what "Keep searching
// farther" uses to list every store holding an item, rather than proving there is
// none closer.
export async function findNearestInStock({ nearby, user, catalog, fetchAround, onProgress, maxCalls = 20, gapMs = 0, probe = {}, exhaustive = false }) {
  const p = { ...DEFAULT_PROBE, ...probe };
  const coords = new Map(catalog.map((s) => [s.id, s]));
  const covered = new Set(nearby.map((s) => s.id));
  const inStock = nearby.filter((s) => s.status === "available");
  let uncovered = catalog
    .filter((s) => !covered.has(s.id))
    .map((s) => ({ ...s, userKm: haversineKm(user, s) }))
    .sort((a, b) => a.userKm - b.userKm);
  const bestKm = () => Math.min(...inStock.map((s) => s.distanceKm ?? Number.POSITIVE_INFINITY));
  const settled = () => !uncovered.length || (!exhaustive && uncovered[0].userKm >= bestKm());
  let calls = 0, rateLimited = false;

  while (!settled() && calls < maxCalls) {
    const centre = planProbe(uncovered, catalog, p);
    let stores, coveredKm = null;
    try {
      if (gapMs && calls) await new Promise((r) => setTimeout(r, gapMs));
      const res = await fetchAround(centre.lat, centre.lon, centre);
      if (Array.isArray(res)) stores = res;
      else { stores = res?.stores ?? []; coveredKm = Number.isFinite(res?.coveredKm) ? res.coveredKm : null; }
    } catch (err) {
      if (err?.code === "rate_limited") { rateLimited = true; break; }
      throw err;
    }
    calls++;
    if (centre.id != null) covered.add(centre.id); // even if walmart does not list it, never probe it twice
    else if (!stores.length && coveredKm == null) covered.add(uncovered[0].id); // centroid probe returned nothing: still make progress
    if (coveredKm != null) for (const s of uncovered) if (haversineKm(centre, s) <= coveredKm) covered.add(s.id);
    for (const s of stores) {
      covered.add(s.id);
      const c = coords.get(s.id);
      const store = { ...s, distanceKm: c ? haversineKm(user, c) : null };
      if (store.status === "available" && !inStock.some((x) => x.id === store.id)) inStock.push(store);
    }
    uncovered = uncovered.filter((s) => !covered.has(s.id));
    onProgress?.({ calls, searched: covered.size, remaining: uncovered.length });
  }

  inStock.sort((a, b) => (a.distanceKm ?? Number.POSITIVE_INFINITY) - (b.distanceKm ?? Number.POSITIVE_INFINITY));
  return { inStock, searched: covered.size, checkedIds: [...covered], calls, complete: !rateLimited && settled(), rateLimited, exhaustive, remaining: uncovered.length };
}
