import { describe, it, expect, vi } from "vitest";
import { findNearestInStock } from "../src/retailers/bestbuy/search.js";
import { haversineKm } from "../src/lib/geo.js";

const USER = { lat: 43.64, lon: -79.39 };
const catalog = [
  { id: "1", name: "Toronto", address: "A", postalCode: "M5V 3L9", lat: 43.65, lon: -79.40 },
  { id: "2", name: "Ottawa", address: "B", postalCode: "K1P 1J1", lat: 45.42, lon: -75.70 },
  { id: "3", name: "Vancouver", address: "C", postalCode: "V6B 1A1", lat: 49.28, lon: -123.12 },
  { id: "4", name: "Halifax", address: "D", postalCode: "B3J 1S9", lat: 44.65, lon: -63.58 },
];
const near = (s, status = "out_of_stock") => ({ ...s, distanceKm: haversineKm(USER, s), status, url: "https://www.bestbuy.ca/x" });

function fakeApi(inStock, { aggregate = "OutOfStock", perCall = 2 } = {}) {
  return {
    LOCATIONS_PER_CALL: perCall,
    getAvailability: vi.fn(async (_sku, ids) => ({
      aggregate, statuses: new Map(ids.map((id) => [id, inStock.has(id) ? "available" : "out_of_stock"])),
    })),
  };
}

describe("bestbuy findNearestInStock", () => {
  it("returns nearby in-stock stores without any call when one is already available", async () => {
    const api = fakeApi(new Set());
    const res = await findNearestInStock({ sku: "1", nearby: [near(catalog[0], "available")], api, catalog });
    expect(api.getAvailability).not.toHaveBeenCalled();
    expect(res.inStock.map((s) => s.id)).toEqual(["1"]);
    expect(res.complete).toBe(true);
  });
  it("checks the remaining stores nearest-first in batches and stops at the first batch with a hit", async () => {
    const api = fakeApi(new Set(["3", "4"]), { perCall: 1 });
    const progress = vi.fn();
    const res = await findNearestInStock({ sku: "1", nearby: [near(catalog[0])], api, catalog, onProgress: progress });
    // Order by distance from Toronto: Ottawa (2), Halifax (4), Vancouver (3) -> two calls, stop at Halifax.
    expect(api.getAvailability.mock.calls.map((c) => c[1])).toEqual([["2"], ["4"]]);
    expect(res.inStock.map((s) => s.id)).toEqual(["4"]);
    // With only one nearby store, locateUser (src/lib/geo.js) falls back to that
    // store's own coordinates (its own test suite asserts this fallback) rather than
    // triangulating the true user position, so the distance to a far store is an
    // estimate, not exact: allow a few km of slack rather than the default 0.5 km.
    expect(res.inStock[0].distanceKm).toBeCloseTo(haversineKm(USER, catalog[3]), -1);
    expect(res.inStock[0].url).toBe("https://www.bestbuy.ca/en-ca/product/1");
    expect(res.complete).toBe(true);
    expect(res.searched).toBe(3);
    expect(new Set(res.checkedIds)).toEqual(new Set(["1", "2", "4"]));
    expect(progress).toHaveBeenCalled();
  });
  it("uses the canonical productUrl for far-store results when given", async () => {
    const api = fakeApi(new Set(["3", "4"]), { perCall: 1 });
    const res = await findNearestInStock({
      sku: "1", nearby: [near(catalog[0])], api, catalog,
      productUrl: "https://www.bestbuy.ca/en-ca/product/playstation-5-slim-1tb-console/1",
    });
    expect(res.inStock[0].url).toBe("https://www.bestbuy.ca/en-ca/product/playstation-5-slim-1tb-console/1");
  });
  it("reports a complete, empty search when nothing is in stock anywhere", async () => {
    const api = fakeApi(new Set(), { perCall: 3 });
    const res = await findNearestInStock({ sku: "1", nearby: [near(catalog[0])], api, catalog });
    expect(res.inStock).toEqual([]);
    expect(res.complete).toBe(true);
    expect(res.searched).toBe(4);
  });
  it("short-circuits when the aggregate says the item is never sold in stores", async () => {
    const api = fakeApi(new Set(), { aggregate: "OnlineOnly", perCall: 1 });
    const res = await findNearestInStock({ sku: "1", nearby: [near(catalog[0])], api, catalog });
    expect(api.getAvailability).toHaveBeenCalledTimes(1);
    expect(res.complete).toBe(true);
    expect(res.inStock).toEqual([]);
  });
  it("treats ids missing from a response as unknown and still counts them as checked", async () => {
    const api = fakeApi(new Set(), { perCall: 3 });
    api.getAvailability.mockResolvedValueOnce({ aggregate: "OutOfStock", statuses: new Map([["2", "out_of_stock"]]) });
    const res = await findNearestInStock({ sku: "1", nearby: [near(catalog[0])], api, catalog });
    expect(res.searched).toBe(4);
    expect(res.complete).toBe(true);
  });
  it("returns partial results with rateLimited on 429", async () => {
    const api = fakeApi(new Set(), { perCall: 1 });
    api.getAvailability.mockRejectedValueOnce(Object.assign(new Error("429"), { code: "rate_limited" }));
    const res = await findNearestInStock({ sku: "1", nearby: [near(catalog[0])], api, catalog });
    expect(res.rateLimited).toBe(true);
    expect(res.complete).toBe(false);
  });
  it("skips ids already checked in an earlier round", async () => {
    const api = fakeApi(new Set(), { perCall: 3 });
    await findNearestInStock({ sku: "1", nearby: [near(catalog[0])], checkedIds: ["2", "3"], api, catalog });
    expect(api.getAvailability.mock.calls[0][1]).toEqual(["4"]);
  });
  it("reports noLocation when the user position cannot be estimated", async () => {
    const api = fakeApi(new Set());
    const res = await findNearestInStock({ sku: "1", nearby: [], api, catalog });
    expect(res.noLocation).toBe(true);
    expect(api.getAvailability).not.toHaveBeenCalled();
  });
});
