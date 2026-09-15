import { describe, it, expect } from "vitest";
import { haversineKm, locateUser } from "../src/lib/geo.js";

const TORONTO = { lat: 43.6426, lon: -79.3871 };
const DUFFERIN = { lat: 43.656461, lon: -79.435147 };

describe("haversineKm", () => {
  it("matches the distance walmart reports for a known pair", () => {
    expect(haversineKm(TORONTO, DUFFERIN)).toBeCloseTo(4.1, 0);
  });
  it("is zero for the same point", () => {
    expect(haversineKm(TORONTO, TORONTO)).toBe(0);
  });
});

describe("locateUser", () => {
  const catalog = new Map([
    ["a", { lat: 43.656461, lon: -79.435147 }],
    ["b", { lat: 43.667826, lon: -79.485341 }],
    ["c", { lat: 43.708987, lon: -79.474216 }],
    ["d", { lat: 43.60, lon: -79.30 }],
    ["e", { lat: 43.80, lon: -79.20 }],
  ]);
  const withDistances = (user, ids) => ids.map((id) => ({ id, distanceKm: Number(haversineKm(user, catalog.get(id)).toFixed(2)) }));

  it("recovers the user position from store distances", () => {
    const stores = withDistances(TORONTO, ["a", "b", "c", "d", "e"]);
    const got = locateUser(stores, catalog);
    expect(haversineKm(got, TORONTO)).toBeLessThan(0.1);
  });
  it("ignores stores with unknown coordinates or distance", () => {
    const stores = [...withDistances(TORONTO, ["a", "b", "c"]), { id: "zzz", distanceKm: 3 }, { id: "d", distanceKm: null }];
    const got = locateUser(stores, catalog);
    expect(haversineKm(got, TORONTO)).toBeLessThan(0.1);
  });
  it("falls back to the nearest store when only one is usable", () => {
    expect(locateUser([{ id: "a", distanceKm: 2.6 }], catalog)).toEqual(catalog.get("a"));
  });
  it("returns null when nothing is usable", () => {
    expect(locateUser([{ id: "zzz", distanceKm: 1 }], catalog)).toBeNull();
    expect(locateUser([], catalog)).toBeNull();
  });
});
