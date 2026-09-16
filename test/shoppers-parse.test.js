import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseProduct, parseStoreDetails } from "../src/retailers/shoppers/parse.js";

const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8"));

describe("parseProduct", () => {
  it("maps the variant details to an Item", () => {
    const item = parseProduct(fx("shoppers-variant.json"), "625273036947");
    expect(item).toMatchObject({ id: "625273036947", name: "Webber Magnesium Bisglycinate 200 mg", priceString: "$14.99", retailer: "shoppers", pickupEligible: true });
    expect(item.url).toBe("https://www.shoppersdrugmart.ca/webber-magnesium-bisglycinate-200-mg/p/BB_625273036947?variantCode=625273036947");
    expect(item.imageUrl).toMatch(/^https:\/\/digital\.loblaws\.ca\/SDM\/SDM_625273036947\/en\/1\/625273036947_en_01_v3_\d+\.jpeg$/);
  });
  it("falls back to the regular price, the relative url and no image", () => {
    const item = parseProduct({ name: "X", price: { value: 5, formattedValue: "$5.00" }, url: "/x/p/BB_1?variantCode=1", images: [] }, "1");
    expect(item.priceString).toBe("$5.00");
    expect(item.url).toBe("https://www.shoppersdrugmart.ca/x/p/BB_1?variantCode=1");
    expect(item.imageUrl).toBeNull();
    expect(item.name).toBe("X");
  });
  it("flags bopisIneligible products as not pickup-eligible", () => {
    expect(parseProduct({ name: "X", bopisIneligible: true }, "1").pickupEligible).toBe(false);
  });
  it("throws api_changed on an unexpected shape", () => {
    expect(() => parseProduct({ errors: [] }, "1")).toThrow(expect.objectContaining({ code: "api_changed" }));
    expect(() => parseProduct(null, "1")).toThrow(expect.objectContaining({ code: "api_changed" }));
  });
});

describe("parseStoreDetails", () => {
  it("maps store inventory rows to Stores, nearest first, quantity > 0 as available", () => {
    const stores = parseStoreDetails(fx("shoppers-store-details.json"));
    expect(stores).toHaveLength(10);
    expect(stores[0]).toEqual({
      id: "1321", name: "Shoppers Drug Mart Queen's Quay", address: "390 QUEEN'S QUAY WEST, TORONTO, ON M5V 3A6", postalCode: "M5V 3A6",
      distanceKm: 0.46, status: "available", url: null,
    });
    expect(stores[1]).toMatchObject({ id: "1320", status: "out_of_stock", distanceKm: 0.67 });
    expect(stores.map((s) => s.distanceKm)).toEqual([...stores.map((s) => s.distanceKm)].sort((a, b) => a - b));
  });
  it("returns [] for an empty (204) response", () => {
    expect(parseStoreDetails(null)).toEqual([]);
    expect(parseStoreDetails("")).toEqual([]);
  });
  it("marks a missing quantity as unknown and drops rows without a store id", () => {
    const stores = parseStoreDetails({ storeInventory: [{ store: { storeId: "1", storeAddress: {} } }, { quantity: 2, store: {} }] });
    expect(stores).toEqual([{ id: "1", name: "Shoppers Drug Mart 1", address: "", postalCode: "", distanceKm: null, status: "unknown", url: null }]);
  });
  it("throws api_changed when storeInventory is missing", () => {
    expect(() => parseStoreDetails({ errors: [{ message: "x" }] })).toThrow(expect.objectContaining({ code: "api_changed" }));
  });
});
