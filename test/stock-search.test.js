import { describe, it, expect, vi } from "vitest";
import { haversineKm } from "../src/lib/geo.js";
import { findNearestInStock, planProbe } from "../src/lib/stock-search.js";

// A synthetic catalog: a dense cluster near the user, then stores every ~150 km eastward.
const USER = { lat: 45, lon: -75 };
const catalog = [];
for (let i = 0; i < 12; i++) catalog.push({ id: `n${i}`, lat: 45 + i * 0.05, lon: -75 - i * 0.05 });
for (let i = 1; i <= 20; i++) catalog.push({ id: `e${i}`, lat: 45, lon: -75 + i * 1.9 });
const byId = new Map(catalog.map((s) => [s.id, s]));
const mk = (id, status, centre) => ({ id, name: id, address: "", postalCode: "", status, accessPointId: "ap-" + id,
  distanceKm: Number(haversineKm(centre, byId.get(id)).toFixed(2)) });

// Fake API: the 50 catalog stores nearest the centre within 100 km (walmart's behaviour with radius 100).
function fakeApi(inStockIds, extra = {}) {
  return vi.fn(async (lat, lon) => {
    const centre = { lat, lon };
    return catalog
      .map((s) => ({ s, d: haversineKm(centre, s) }))
      .filter(({ d }) => d <= 100)
      .sort((a, b) => a.d - b.d)
      .slice(0, 50)
      .map(({ s }) => ({ ...mk(s.id, inStockIds.has(s.id) ? "available" : "out_of_stock", centre), ...extra }));
  });
}
const nearby = (inStockIds) => catalog.slice(0, 10).map((s) => mk(s.id, inStockIds.has(s.id) ? "available" : "out_of_stock", USER));

describe("planProbe", () => {
  it("keeps the search nearest-first: the chosen probe must reach the nearest uncovered store", () => {
    // Stores 150 km apart: a centroid between two of them would cover 2, but not the nearest one.
    const uncovered = catalog.filter((s) => s.id.startsWith("e")).map((s) => ({ ...s, userKm: haversineKm(USER, s) }));
    const c = planProbe(uncovered, catalog);
    expect(c.id).toBe("e1");
  });
  it("moves the centre into the unchecked cluster when that covers more", () => {
    // Nearest uncovered store sits at the edge of a cluster; a store-centred probe would waste its 50 slots on checked stores.
    const checked = [], unchecked = [];
    for (let i = 0; i < 60; i++) checked.push({ id: `c${i}`, lat: 45 - 0.02 * i, lon: -75 + 0.01 * i });
    for (let i = 0; i < 60; i++) unchecked.push({ id: `u${i}`, lat: 45.05 + 0.02 * i, lon: -75 - 0.01 * i });
    const all = [...checked, ...unchecked];
    const uncovered = unchecked.map((s) => ({ ...s, userKm: haversineKm({ lat: 44, lon: -75 }, s) })).sort((a, b) => a.userKm - b.userKm);
    const c = planProbe(uncovered, all);
    expect(c.id).toBeNull(); // a centroid, not a store
    expect(c.lat).toBeGreaterThan(uncovered[0].lat);
  });
});

describe("findNearestInStock", () => {
  it("returns nearby in-stock stores without extra calls when one is already in stock", async () => {
    const api = fakeApi(new Set(["n3"]));
    const res = await findNearestInStock({ nearby: nearby(new Set(["n3"])), user: USER, catalog, fetchAround: api });
    expect(api).not.toHaveBeenCalled();
    expect(res.inStock.map((s) => s.id)).toEqual(["n3"]);
    expect(res.complete).toBe(true);
  });

  it("searches outward and finds the nearest far store, with distance measured from the user", async () => {
    const api = fakeApi(new Set(["e7", "e9"]));
    const progress = vi.fn();
    const res = await findNearestInStock({ nearby: nearby(new Set()), user: USER, catalog, fetchAround: api, onProgress: progress });
    expect(res.inStock[0].id).toBe("e7");
    expect(res.inStock[0].distanceKm).toBeCloseTo(haversineKm(USER, byId.get("e7")), 0);
    expect(res.complete).toBe(true);
    expect(progress).toHaveBeenCalled();
    // Stops once every uncovered store is farther than the best hit; e9 would need more probes.
    const lastCentreLon = api.mock.calls.at(-1)[1];
    expect(lastCentreLon).toBeLessThan(byId.get("e9").lon);
  });

  it("reports exhaustion when nothing is in stock anywhere", async () => {
    const api = fakeApi(new Set());
    const res = await findNearestInStock({ nearby: nearby(new Set()), user: USER, catalog, fetchAround: api, maxCalls: 100 });
    expect(res.inStock).toEqual([]);
    expect(res.complete).toBe(true);
    expect(res.searched).toBe(catalog.length);
    expect(new Set(res.checkedIds)).toEqual(new Set(catalog.map((s) => s.id)));
  });

  it("stops at maxCalls and reports an incomplete search", async () => {
    // A 15x15 grid of stores ~55 km apart: far more than two 50-store probes can cover.
    const big = [];
    for (let i = 0; i < 15; i++) for (let j = 0; j < 15; j++) big.push({ id: `g${i}-${j}`, lat: 45 + i * 0.5, lon: -75 + j * 0.7 });
    const bigById = new Map(big.map((s) => [s.id, s]));
    const api = vi.fn(async (lat, lon) => big
      .map((s) => ({ s, d: haversineKm({ lat, lon }, s) })).filter(({ d }) => d <= 100).sort((a, b) => a.d - b.d).slice(0, 50)
      .map(({ s, d }) => ({ id: s.id, name: s.id, status: "out_of_stock", distanceKm: d, accessPointId: null })));
    const near = big.slice(0, 10).map((s) => ({ id: s.id, status: "out_of_stock", distanceKm: haversineKm(USER, bigById.get(s.id)), accessPointId: null }));
    const res = await findNearestInStock({ nearby: near, user: USER, catalog: big, fetchAround: api, maxCalls: 2 });
    expect(api).toHaveBeenCalledTimes(2);
    expect(res.complete).toBe(false);
    expect(res.searched).toBeLessThan(big.length);
  });

  it("returns partial results with rateLimited when the API throws rate_limited", async () => {
    const api = vi.fn().mockRejectedValue(Object.assign(new Error("429"), { code: "rate_limited" }));
    const res = await findNearestInStock({ nearby: nearby(new Set()), user: USER, catalog, fetchAround: api });
    expect(res.rateLimited).toBe(true);
    expect(res.complete).toBe(false);
  });

  it("propagates other errors", async () => {
    const api = vi.fn().mockRejectedValue(Object.assign(new Error("boom"), { code: "api_changed" }));
    await expect(findNearestInStock({ nearby: nearby(new Set()), user: USER, catalog, fetchAround: api })).rejects.toMatchObject({ code: "api_changed" });
  });

  it("keeps a returned store that is missing from the catalog, with unknown distance", async () => {
    const api = fakeApi(new Set(["e2"]));
    api.mockImplementationOnce(async (lat, lon) => [{ ...mk("e2", "available", { lat, lon }), id: "new-store", distanceKm: 3 }, ...(await fakeApi(new Set(["e2"]))(lat, lon))]);
    const res = await findNearestInStock({ nearby: nearby(new Set()), user: USER, catalog, fetchAround: api });
    const ids = res.inStock.map((s) => s.id);
    expect(ids).toContain("new-store");
    expect(res.inStock.find((s) => s.id === "new-store").distanceKm).toBeNull();
    expect(ids[0]).toBe("e2");
  });

  it("does not loop forever when the API never returns the probe centre", async () => {
    const api = vi.fn(async () => []);
    const res = await findNearestInStock({ nearby: nearby(new Set()), user: USER, catalog, fetchAround: api, maxCalls: 100 });
    expect(res.complete).toBe(true);
    expect(api.mock.calls.length).toBeLessThanOrEqual(catalog.length);
  });
});

describe("probe options", () => {
  // Stores 60 km apart in a line; a 5-store / 90 km probe centred on a store reaches only its neighbours.
  const line = [];
  for (let i = 0; i < 30; i++) line.push({ id: `l${i}`, lat: 45, lon: -75 + i * 0.76, postalCode: `P${i}` });
  const lineUser = { lat: 45, lon: -75 };
  const lineApi = (inStock, seen) => vi.fn(async (lat, lon, centre) => {
    seen?.push(centre);
    return line
      .map((s) => ({ s, d: haversineKm({ lat, lon }, s) })).filter(({ d }) => d <= 90).sort((a, b) => a.d - b.d).slice(0, 5)
      .map(({ s, d }) => ({ id: s.id, name: s.id, address: "", postalCode: s.postalCode, status: inStock.has(s.id) ? "available" : "out_of_stock", distanceKm: d, accessPointId: null, url: null }));
  });
  const lineNearby = (inStock) => line.slice(0, 5).map((s) => ({ id: s.id, status: inStock.has(s.id) ? "available" : "out_of_stock", distanceKm: haversineKm(lineUser, s) }));

  it("planProbe with centroids disabled only ever returns a catalog store, nearest-first", () => {
    // The coverage-maximizing scorer prefers l6 over l5: l5's own window wastes a slot on an
    // already-covered neighbour, while l6's window covers more of the uncovered run.
    const uncovered = line.slice(5).map((s) => ({ ...s, userKm: haversineKm(lineUser, s) }));
    const c = planProbe(uncovered, line, { maxCount: 5, radiusKm: 90, centroids: false });
    expect(c.id).toBe("l6");
    expect(c.postalCode).toMatch(/^P\d+$/);
    // Nearest-first invariant: the chosen centre must still be within probe range of the nearest uncovered store.
    expect(haversineKm(c, uncovered[0])).toBeLessThanOrEqual(90);
  });

  it("passes the chosen centre (with its catalog fields) to fetchAround and honours maxCount/radius", async () => {
    const seen = [];
    const api = lineApi(new Set(["l12"]), seen);
    const res = await findNearestInStock({ nearby: lineNearby(new Set()), user: lineUser, catalog: line, fetchAround: api,
      maxCalls: 20, probe: { maxCount: 5, radiusKm: 90, centroids: false } });
    expect(res.inStock.map((s) => s.id)).toEqual(["l12"]);
    expect(res.complete).toBe(true);
    for (const c of seen) { expect(c.id).toMatch(/^l\d+$/); expect(c.postalCode).toMatch(/^P\d+$/); }
    // 5 stores per call spaced 60 km: reaching l12 from l5 takes 2-3 calls, never 20.
    expect(api.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it("keeps the default (walmart) behaviour when no options are given", async () => {
    const api = fakeApi(new Set(["e7"]));
    const res = await findNearestInStock({ nearby: nearby(new Set()), user: USER, catalog, fetchAround: api });
    expect(res.inStock[0].id).toBe("e7");
    expect(api.mock.calls[0].length).toBe(3); // lat, lon, centre
  });
});

describe("coveredKm responses", () => {
  // Stores 10 km apart in a line; the API returns the nearest in-stock stores only (max 3 within 25 km)
  // and reports how far its answer is known to cover.
  const line = [];
  for (let i = 0; i < 30; i++) line.push({ id: `s${i}`, lat: 45, lon: -75 + i * 0.1268 });
  const lineUser = { lat: 45, lon: -75 };
  const inStockApi = (inStock) => vi.fn(async (lat, lon) => {
    const hits = line
      .map((s) => ({ s, d: haversineKm({ lat, lon }, s) })).filter(({ s, d }) => d <= 25 && inStock.has(s.id)).sort((a, b) => a.d - b.d).slice(0, 3);
    return { stores: hits.map(({ s, d }) => ({ id: s.id, name: s.id, status: "available", distanceKm: d, url: null })), coveredKm: hits.length === 3 ? hits[2].d : 25 };
  });
  const lineNearby = () => line.slice(0, 3).map((s) => ({ id: s.id, status: "out_of_stock", distanceKm: haversineKm(lineUser, s) }));

  it("treats every catalog store within coveredKm of the centre as checked", async () => {
    const api = inStockApi(new Set(["s12"]));
    const res = await findNearestInStock({ nearby: lineNearby(), user: lineUser, catalog: line, fetchAround: api, probe: { maxCount: 3, radiusKm: 25, centroids: false } });
    expect(res.inStock.map((s) => s.id)).toEqual(["s12"]);
    expect(res.complete).toBe(true);
    // ~120 km to s12 with 25 km coverage per empty probe: a handful of calls, not one per out-of-stock store.
    expect(api.mock.calls.length).toBeLessThanOrEqual(6);
    expect(res.checkedIds).toContain("s5");
  });
  it("only covers up to the farthest hit when the response is full", async () => {
    const api = inStockApi(new Set(["s4", "s5", "s6", "s9"]));
    const res = await findNearestInStock({ nearby: lineNearby(), user: lineUser, catalog: line, fetchAround: api, maxCalls: 1, probe: { maxCount: 3, radiusKm: 25, centroids: false } });
    expect(res.inStock.map((s) => s.id)).toEqual(["s4", "s5", "s6"]);
    expect(res.checkedIds).not.toContain("s9");
    expect(res.complete).toBe(true); // nothing uncovered is nearer than s4
  });
  it("still accepts a plain array response", async () => {
    const api = vi.fn(async () => []);
    const res = await findNearestInStock({ nearby: lineNearby(), user: lineUser, catalog: line, fetchAround: api, maxCalls: 100, probe: { maxCount: 3, radiusKm: 25, centroids: false } });
    expect(res.complete).toBe(true);
  });
});
