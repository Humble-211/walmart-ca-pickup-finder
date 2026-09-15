import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseProduct, parseStores, parseAvailability } from "../src/retailers/bestbuy/parse.js";

const load = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8"));

describe("bestbuy parsers", () => {
  it("parseProduct maps the catalog item, defaulting to the first when no sku is given", () => {
    const item = parseProduct(load("bestbuy-product.json"));
    expect(item.retailer).toBe("bestbuy");
    expect(item.id).toBe("19491570");
    expect(item.name).toBe("PlayStation 5 DualSense Wireless Controller For PS5, PC, Mac & Mobile - Midnight Black");
    expect(item.url).toBe("https://www.bestbuy.ca/en-ca/product/playstation-5-dualsense-wireless-controller-for-ps5-pc-mac-mobile-midnight-black/19491570");
    expect(item.priceString).toBe("$94.99");
    expect(item.imageUrl).toBe("https://multimedia.bbycastatic.ca/multimedia/products/150x150/194/19491/19491570.jpg");
    expect(item.pickupEligible).toBe(true);
  });
  it("parseProduct selects the item matching the given sku", () => {
    const item = parseProduct(load("bestbuy-product.json"), "19446111");
    expect(item.id).toBe("19446111");
    expect(item.name).toBe("PlayStation 5 Slim 1TB Console");
    expect(item.priceString).toBe("$819.99");
  });
  it("parseProduct falls back to the first item when the sku isn't present", () => {
    const item = parseProduct(load("bestbuy-product.json"), "00000000");
    expect(item.id).toBe("19491570");
  });
  it("parseProduct throws not_found when the catalog has no items", () => {
    expect(() => parseProduct({ currentPage: 1, total: 0, totalPages: 1, pageSize: 20, items: [] }))
      .toThrow(expect.objectContaining({ code: "not_found" }));
  });
  it("parseProduct throws api_changed on an unexpected shape", () => {
    expect(() => parseProduct({ foo: 1 })).toThrow(expect.objectContaining({ code: "api_changed" }));
  });
  it("parseProduct yields an empty priceString when both prices are null", () => {
    const item = parseProduct({ items: [{ sku: "19446111", name: "PlayStation 5 Slim 1TB Console", salePrice: null, regularPrice: null }] });
    expect(item.priceString).toBe("");
  });
  it("parseProduct marks online-only items as not pickup eligible", () => {
    const item = parseProduct({ items: [{ sku: "1", name: "Online Only Thing", salePrice: 1, isOnlineOnly: true }] });
    expect(item.pickupEligible).toBe(false);
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
