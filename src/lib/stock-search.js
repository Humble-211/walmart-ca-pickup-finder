// Nearest-first search for stores that have an item in stock, beyond the handful
// walmart returns around a postal code. Each nearByNodes call returns at most
// the 50 stores nearest a point within 100 km (the largest radius accepted;
// leaving it out means ~50 km), so we probe outward from the user, placing each
// probe where its response would contain the most not-yet-checked stores, until
// the nearest in-stock store is certain or the call budget is spent.
import { haversineKm } from "./geo.js";

export const PROBE_MAX_COUNT = 50;
export const PROBE_RADIUS_KM = 100;
const CANDIDATES = 12;

// What a probe at `centre` would return: the nearest catalog stores within the radius, capped.
function simulateProbe(centre, catalog) {
  return catalog
    .map((s) => ({ s, d: haversineKm(centre, s) }))
    .filter(({ d }) => d <= PROBE_RADIUS_KM)
    .sort((a, b) => a.d - b.d)
    .slice(0, PROBE_MAX_COUNT)
    .map(({ s }) => s);
}

// uncovered: [{id, lat, lon, userKm}] sorted by userKm; catalog: every known store.
// Candidates are the nearest uncovered stores and, for each, the centroid of the
// uncovered stores within probe range of it (which pulls the centre into the
// unchecked mass). The winner is the candidate whose simulated response includes
// the nearest uncovered store (so the search stays nearest-first) and holds the
// most uncovered stores; ties go to the earlier, nearer candidate.
export function planProbe(uncovered, catalog = uncovered) {
  const uncoveredIds = new Set(uncovered.map((s) => s.id));
  const target = uncovered[0];
  const seeds = uncovered.slice(0, CANDIDATES);
  const candidates = [...seeds];
  for (const c of seeds) {
    const near = uncovered.filter((s) => haversineKm(c, s) <= PROBE_RADIUS_KM);
    candidates.push({ id: null, lat: near.reduce((a, s) => a + s.lat, 0) / near.length, lon: near.reduce((a, s) => a + s.lon, 0) / near.length });
  }
  let best = null, bestKey = [-1, -1];
  for (const c of candidates) {
    const response = simulateProbe(c, catalog);
    const key = [response.some((s) => s.id === target.id) ? 1 : 0, response.filter((s) => uncoveredIds.has(s.id)).length];
    if (key[0] > bestKey[0] || (key[0] === bestKey[0] && key[1] > bestKey[1])) { best = c; bestKey = key; }
  }
  return best;
}

export async function findNearestInStock({ nearby, user, catalog, fetchAround, onProgress, maxCalls = 20, gapMs = 0 }) {
  const coords = new Map(catalog.map((s) => [s.id, s]));
  const covered = new Set(nearby.map((s) => s.id));
  const inStock = nearby.filter((s) => s.status === "available");
  let uncovered = catalog
    .filter((s) => !covered.has(s.id))
    .map((s) => ({ id: s.id, lat: s.lat, lon: s.lon, userKm: haversineKm(user, s) }))
    .sort((a, b) => a.userKm - b.userKm);
  const bestKm = () => Math.min(...inStock.map((s) => s.distanceKm ?? Number.POSITIVE_INFINITY));
  const settled = () => !uncovered.length || uncovered[0].userKm >= bestKm();
  let calls = 0, rateLimited = false;

  while (!settled() && calls < maxCalls) {
    const centre = planProbe(uncovered, catalog);
    let stores;
    try {
      if (gapMs && calls) await new Promise((r) => setTimeout(r, gapMs));
      stores = await fetchAround(centre.lat, centre.lon);
    } catch (err) {
      if (err?.code === "rate_limited") { rateLimited = true; break; }
      throw err;
    }
    calls++;
    if (centre.id != null) covered.add(centre.id); // even if walmart does not list it, never probe it twice
    else if (!stores.length) covered.add(uncovered[0].id); // centroid probe returned nothing: still make progress
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
  return { inStock, searched: covered.size, checkedIds: [...covered], calls, complete: !rateLimited && settled(), rateLimited };
}
