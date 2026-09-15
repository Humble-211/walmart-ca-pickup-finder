import { describe, it, expect } from "vitest";
import { parseProductUrl } from "../src/retailers/shoppers/urls.js";

describe("shoppers parseProductUrl", () => {
  it("returns the variant code when the URL carries one", () => {
    expect(parseProductUrl("https://www.shoppersdrugmart.ca/bioderma-sensibio-h2o/p/BB_3701129812075?variantCode=3701129812105")).toBe("3701129812105");
  });
  it("falls back to the base code without ?variantCode", () => {
    expect(parseProductUrl("https://www.shoppersdrugmart.ca/webber-magnesium-bisglycinate-200-mg/p/BB_625273036947")).toBe("625273036947");
    expect(parseProductUrl("https://shoppersdrugmart.ca/p/BB_625273036947#reviews")).toBe("625273036947");
  });
  it("ignores other query parameters and upper-cases the code", () => {
    expect(parseProductUrl("https://www.shoppersdrugmart.ca/x/p/bb_abc123?lang=fr&variantCode=abc124&foo=1")).toBe("ABC124");
  });
  it("rejects bare codes, non-product pages and other hosts", () => {
    expect(parseProductUrl("625273036947")).toBeNull();
    expect(parseProductUrl("BB_625273036947")).toBeNull();
    expect(parseProductUrl("https://www.shoppersdrugmart.ca/shop/categories/health/c/57127")).toBeNull();
    expect(parseProductUrl("https://www.shoppersdrugmart.ca/store-locator")).toBeNull();
    expect(parseProductUrl("https://www.staples.ca/products/3082604-en-brother-printer")).toBeNull();
    expect(parseProductUrl("")).toBeNull();
  });
});
