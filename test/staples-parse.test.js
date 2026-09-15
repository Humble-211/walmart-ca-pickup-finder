import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseProduct, parseAvailability } from "../src/retailers/staples/parse.js";

const load = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8"));
const product = load("staples-product.json");
const availability = load("staples-availability.json");
const HANDLE = product.handle;
const SKU = product.variants[0].sku;

describe("staples parseProduct", () => {
  it("maps title, cents price, https image, canonical url, retailer and pickup eligibility", () => {
    const item = parseProduct(product, HANDLE);
    expect(item).toMatchObject({ id: HANDLE, name: product.title, retailer: "staples", url: "https://www.staples.ca" + product.url });
    expect(item.priceString).toBe(`$${(product.price / 100).toFixed(2)}`);
    expect(item.imageUrl).toMatch(/^https:\/\/cdn\.shopify\.com\//);
    expect(item.pickupEligible).toBe(!product.tags.includes("bopis_eligible:False"));
  });
  it("marks bopis_eligible:False items as not pickup eligible", () => {
    const item = parseProduct({ ...product, tags: ["bopis_eligible:False"] }, HANDLE);
    expect(item.pickupEligible).toBe(false);
  });
  it("matches the bopis_eligible tag case-insensitively", () => {
    const item = parseProduct({ ...product, tags: ["bopis_eligible:false"] }, HANDLE);
    expect(item.pickupEligible).toBe(false);
  });
  it("throws api_changed on an unexpected shape", () => {
    expect(() => parseProduct({ foo: 1 }, HANDLE)).toThrow(expect.objectContaining({ code: "api_changed" }));
  });
  it("falls back to an empty priceString, a null imageUrl, and a built url when those fields are missing", () => {
    const { price, featured_image, url, ...rest } = product;
    const item = parseProduct(rest, HANDLE);
    expect(item.priceString).toBe("");
    expect(item.imageUrl).toBeNull();
    expect(item.url).toBe(`https://www.staples.ca/products/${HANDLE}`);
  });
});

describe("staples parseAvailability", () => {
  it("returns the stores for the sku, nearest first, with quantity mapped to status", () => {
    const stores = parseAvailability(availability, SKU);
    expect(stores.length).toBeGreaterThan(0);
    const raw = availability.availability[SKU];
    for (const s of stores) {
      const r = raw[s.id];
      expect(r).toBeDefined();
      expect(s.status).toBe(r.availableqty > 0 ? "available" : "out_of_stock");
      expect(s.distanceKm).toBeCloseTo(Number(r.distance), 5);
      expect(s.address).toContain(r.city);
      expect(s.postalCode).toBe(r.zipCode);
      expect(s.url).toBeNull();
    }
    for (let i = 1; i < stores.length; i++) expect(stores[i].distanceKm).toBeGreaterThanOrEqual(stores[i - 1].distanceKm);
  });
  it("returns an empty list for the empty map (unknown sku / not eligible / no store in range)", () => {
    expect(parseAvailability({ success: true, availability: { [SKU]: {} } }, SKU)).toEqual([]);
    expect(parseAvailability({ success: true, availability: {} }, SKU)).toEqual([]);
  });
  it("throws api_changed when the availability object is missing", () => {
    expect(() => parseAvailability({ success: false }, SKU)).toThrow(expect.objectContaining({ code: "api_changed" }));
  });
  it("maps a non-numeric or missing availableqty to status unknown", () => {
    const stores = parseAvailability({ availability: { [SKU]: {
      "1": { city: "A", zipCode: "A1A 1A1", distance: "1", availableqty: "n/a" },
      "2": { city: "B", zipCode: "B2B 2B2", distance: "2" },
    } } }, SKU);
    expect(stores.find((s) => s.id === "1").status).toBe("unknown");
    expect(stores.find((s) => s.id === "2").status).toBe("unknown");
  });
  it("sorts a store with a non-numeric distance (null distanceKm) last", () => {
    const stores = parseAvailability({ availability: { [SKU]: {
      "1": { city: "Far", zipCode: "A1A 1A1", distance: "50", availableqty: 1 },
      "2": { city: "Unknown distance", zipCode: "B2B 2B2", distance: "n/a", availableqty: 1 },
      "3": { city: "Near", zipCode: "C3C 3C3", distance: "1", availableqty: 1 },
    } } }, SKU);
    expect(stores.map((s) => s.id)).toEqual(["3", "1", "2"]);
    expect(stores.find((s) => s.id === "2").distanceKm).toBeNull();
  });
});
