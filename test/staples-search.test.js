import { describe, it, expect, vi } from "vitest";
import { searchInStock, withCatalogNames } from "../src/retailers/staples/search.js";
import { haversineKm } from "../src/lib/geo.js";

// 8 stores along a line 60 km apart; the API returns the 5 nearest within 90 km of the seed store's postal code.
const catalog = [];
for (let i = 0; i < 8; i++) catalog.push({ id: `${100 + i}`, name: `Staples ${i}`, address: `${i} Main St`, postalCode: `K${i}A 1A1`, lat: 45, lon: -75 + i * 0.76 });
const byPostal = new Map(catalog.map((s) => [s.postalCode, s]));
const USER = { lat: 45, lon: -75 };
const fakeApi = (inStock) => ({
  getAvailability: vi.fn(async (_sku, postalCode) => {
    const centre = byPostal.get(postalCode);
    return catalog.map((s) => ({ s, d: haversineKm(centre, s) })).filter(({ d }) => d <= 90).sort((a, b) => a.d - b.d).slice(0, 5)
      .map(({ s, d }) => ({ id: s.id, name: s.name, address: s.address, postalCode: s.postalCode, distanceKm: d, status: inStock.has(s.id) ? "available" : "out_of_stock", url: null }));
  }),
});
const nearby = (inStock) => catalog.slice(0, 5).map((s) => ({ id: s.id, name: s.name, address: s.address, postalCode: s.postalCode, distanceKm: haversineKm(USER, s), status: inStock.has(s.id) ? "available" : "out_of_stock", url: null }));

describe("staples searchInStock", () => {
  it("probes outward seeded with catalog stores' postal codes and stamps the product url", async () => {
    const api = fakeApi(new Set(["106"]));
    const res = await searchInStock({ sku: "1", nearby: nearby(new Set()), catalog, api, productUrl: "https://www.staples.ca/products/x" });
    expect(res.inStock.map((s) => s.id)).toEqual(["106"]);
    expect(res.inStock[0].url).toBe("https://www.staples.ca/products/x");
    expect(res.inStock[0].distanceKm).toBeCloseTo(haversineKm(USER, catalog[6]), 0);
    for (const call of api.getAvailability.mock.calls) expect(byPostal.has(call[1])).toBe(true);
    expect(res.complete).toBe(true);
  });
  it("returns nearby stock without a call", async () => {
    const api = fakeApi(new Set(["101"]));
    const res = await searchInStock({ sku: "1", nearby: nearby(new Set(["101"])), catalog, api, productUrl: "u" });
    expect(api.getAvailability).not.toHaveBeenCalled();
    expect(res.inStock[0].id).toBe("101");
  });
  it("reports noLocation when no nearby store is in the catalog", async () => {
    const api = fakeApi(new Set());
    const res = await searchInStock({ sku: "1", nearby: [{ id: "999", status: "out_of_stock", distanceKm: 1 }], catalog, api, productUrl: "u" });
    expect(res.noLocation).toBe(true);
    expect(res.calls).toBe(0);
  });
});

describe("withCatalogNames", () => {
  const catalogById = new Map([["3", { id: "3", name: "Staples Toronto - Leaside" }]]);
  it("replaces a returned store's parsed name with the catalog name when the id is known", () => {
    const stores = [{ id: "3", name: "Staples Toronto" }];
    expect(withCatalogNames(stores, catalogById)[0].name).toBe("Staples Toronto - Leaside");
  });
  it("falls back to the parsed name when the id is not in the catalog", () => {
    const stores = [{ id: "999", name: "Staples Nowhere" }];
    expect(withCatalogNames(stores, catalogById)[0].name).toBe("Staples Nowhere");
  });
});

// Staples covers 302 stores five at a time, so its remaining work is always "cover
// the rest of the catalogue", never "find something closer". It therefore reports
// itself unfinished while stores are unchecked, even when a nearby one has stock,
// so "Keep searching farther" stays available to run the sweep.
describe("staples sweeps its whole catalogue", () => {
  it("stays unfinished while stores are unchecked, even with stock next door", async () => {
    const api = fakeApi(new Set(["100"]));
    const res = await searchInStock({ sku: "1", nearby: nearby(new Set(["100"])), api, catalog, gapMs: 0, productUrl: "u" });
    expect(res.inStock.map((s) => s.id)).toEqual(["100"]);
    expect(res.complete).toBe(false);
    expect(res.exhaustive).toBe(true);
    expect(res.remaining).toBeGreaterThan(0);
  });

  it("reports finished once every store has been checked", async () => {
    const api = fakeApi(new Set());
    const res = await searchInStock({ sku: "1", nearby: nearby(new Set()), api, catalog, gapMs: 0, productUrl: "u", exhaustive: true, maxCalls: 40 });
    expect(res.remaining).toBe(0);
    expect(res.complete).toBe(true);
  });

  it("finds a far store the nearest-only search would never have reached", async () => {
    const api = fakeApi(new Set(["100", "107"]));
    const res = await searchInStock({ sku: "1", nearby: nearby(new Set(["100"])), api, catalog, gapMs: 0, productUrl: "u", exhaustive: true, maxCalls: 40 });
    expect(res.inStock.map((s) => s.id)).toEqual(["100", "107"]);
    expect(res.complete).toBe(true);
  });
});
