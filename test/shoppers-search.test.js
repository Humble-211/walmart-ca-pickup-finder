import { describe, it, expect, vi } from "vitest";
import { searchInStock, PROBE } from "../src/retailers/shoppers/search.js";
import { haversineKm } from "../src/lib/geo.js";

// 40 stores along a line 5 km apart; the API returns the 10 nearest within 20 km, in-stock only when asked.
const catalog = [];
for (let i = 0; i < 40; i++) catalog.push({ id: `${1000 + i}`, name: `Shoppers Drug Mart ${i}`, address: `${i} Main St`, postalCode: `K${i % 10}A 1A1`, lat: 45, lon: -75 + i * 0.0634 });
const USER = { lat: 45, lon: -75 };
const fakeApi = (inStock) => ({
  getStoreStock: vi.fn(async (_code, centre, inStockOnly) => catalog
    .map((s) => ({ s, d: haversineKm(centre, s) })).filter(({ d }) => d <= 20).filter(({ s }) => !inStockOnly || inStock.has(s.id))
    .sort((a, b) => a.d - b.d).slice(0, 10)
    .map(({ s, d }) => ({ id: s.id, name: s.name, address: s.address, postalCode: s.postalCode, distanceKm: d, status: inStock.has(s.id) ? "available" : "out_of_stock", url: null }))),
});
const nearby = (inStock) => catalog.slice(0, 10).map((s) => ({ id: s.id, name: s.name, address: s.address, postalCode: s.postalCode, distanceKm: haversineKm(USER, s), status: inStock.has(s.id) ? "available" : "out_of_stock", url: null }));

describe("shoppers searchInStock", () => {
  it("probes outward asking for in-stock stores only and stamps the product url", async () => {
    const api = fakeApi(new Set(["1030"]));
    const res = await searchInStock({ code: "1", user: USER, nearby: nearby(new Set()), catalog, api, productUrl: "https://www.shoppersdrugmart.ca/x/p/BB_1", gapMs: 0 });
    expect(res.inStock.map((s) => s.id)).toEqual(["1030"]);
    expect(res.inStock[0].url).toBe("https://www.shoppersdrugmart.ca/x/p/BB_1");
    expect(res.inStock[0].distanceKm).toBeCloseTo(haversineKm(USER, catalog[30]), 0);
    expect(res.complete).toBe(true);
    for (const call of api.getStoreStock.mock.calls) expect(call[2]).toBe(true);
    // 150 km away with 20 km covered per empty probe: well under one call per store.
    expect(api.getStoreStock.mock.calls.length).toBeLessThanOrEqual(8);
  });
  it("returns nearby stock without a call", async () => {
    const api = fakeApi(new Set(["1001"]));
    const res = await searchInStock({ code: "1", user: USER, nearby: nearby(new Set(["1001"])), catalog, api, productUrl: "u" });
    expect(api.getStoreStock).not.toHaveBeenCalled();
    expect(res.inStock[0].id).toBe("1001");
  });
  it("reports exhaustion when nothing is in stock anywhere", async () => {
    const api = fakeApi(new Set());
    const res = await searchInStock({ code: "1", user: USER, nearby: nearby(new Set()), catalog, api, productUrl: "u", gapMs: 0 });
    expect(res.inStock).toEqual([]);
    expect(res.complete).toBe(true);
    expect(res.searched).toBe(catalog.length);
  });
  it("reports noLocation without a user position", async () => {
    const api = fakeApi(new Set());
    const res = await searchInStock({ code: "1", user: null, nearby: nearby(new Set()), catalog, api, productUrl: "u" });
    expect(res.noLocation).toBe(true);
    expect(api.getStoreStock).not.toHaveBeenCalled();
  });
  it("uses a 10-store / 20 km probe with centroids", () => {
    expect(PROBE).toEqual({ maxCount: 10, radiusKm: 20, centroids: true });
  });
});
