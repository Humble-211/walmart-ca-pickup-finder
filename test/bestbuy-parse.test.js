import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseProduct, parseStores, parseAvailability } from "../src/retailers/bestbuy/parse.js";

const load = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8"));

describe("bestbuy parsers", () => {
  it("parseProduct maps the catalog item", () => {
    const item = parseProduct(load("bestbuy-product.json"));
    expect(item.retailer).toBe("bestbuy");
    expect(item.id).toMatch(/^\d+$/);
    expect(item.name.length).toBeGreaterThan(3);
    expect(item.url).toMatch(/^https:\/\/www\.bestbuy\.ca\/en-ca\/product\//i);
    expect(item.priceString).toMatch(/^\$\d+\.\d{2}$/);
    expect(item.imageUrl).toMatch(/^https:\/\//);
  });
  it("parseProduct throws not_found when the catalog has no items", () => {
    expect(() => parseProduct({ currentPage: 1, total: 0, totalPages: 1, pageSize: 20, items: [] }))
      .toThrow(expect.objectContaining({ code: "not_found" }));
  });
  it("parseProduct throws api_changed on an unexpected shape", () => {
    expect(() => parseProduct({ foo: 1 })).toThrow(expect.objectContaining({ code: "api_changed" }));
  });
  it("parseStores maps id, address, coordinates and distance", () => {
    const stores = parseStores(load("bestbuy-stores.json"));
    expect(stores.length).toBeGreaterThan(0);
    for (const s of stores) {
      expect(s.id).toMatch(/^\d+$/);
      expect(typeof s.lat).toBe("number");
      expect(typeof s.lon).toBe("number");
      expect(s.address).toContain(s.postalCode);
      expect(typeof s.distanceKm).toBe("number");
    }
  });
  it("parseStores returns an empty list for an unrecognised postal code", () => {
    expect(parseStores({ Brand: "BestBuyCanada", currentPage: 0, pageSize: 0, totalPages: 0, total: 0, locations: [] })).toEqual([]);
  });
  it("parseAvailability maps hasInventory / supportsFulfillment per location and keeps the aggregate", () => {
    const { aggregate, statuses } = parseAvailability(load("bestbuy-availability.json"));
    expect(typeof aggregate).toBe("string");
    expect(statuses.size).toBeGreaterThan(0);
    for (const status of statuses.values()) expect(["available", "out_of_stock", "unknown"]).toContain(status);
  });
  it("parseAvailability applies the documented mapping", () => {
    const json = { availabilities: [{ sku: "1", pickup: { status: "InStock", locations: [
      { locationKey: "1", hasInventory: true, quantityOnHand: 3, supportsFulfillment: true },
      { locationKey: "2", hasInventory: false, quantityOnHand: 0, supportsFulfillment: true },
      { locationKey: "3", hasInventory: false, quantityOnHand: 0, supportsFulfillment: false },
    ] } }] };
    const { statuses } = parseAvailability(json);
    expect([...statuses]).toEqual([["1", "available"], ["2", "out_of_stock"], ["3", "unknown"]]);
  });
  it("parseAvailability throws api_changed when availabilities is missing", () => {
    expect(() => parseAvailability({})).toThrow(expect.objectContaining({ code: "api_changed" }));
  });
});
