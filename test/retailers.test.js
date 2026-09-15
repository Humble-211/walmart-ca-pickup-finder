import { describe, it, expect } from "vitest";
import { RETAILERS, parseProductUrl } from "../src/retailers/index.js";

describe("parseProductUrl", () => {
  it("routes a bestbuy.ca product URL to the bestbuy adapter", () => {
    expect(parseProductUrl("https://www.bestbuy.ca/en-ca/product/playstation-5-pro-console/18291446"))
      .toEqual({ retailer: "bestbuy", itemId: "18291446" });
  });
  it("routes a staples.ca product URL to the staples adapter with the handle as item id", () => {
    expect(parseProductUrl("https://www.staples.ca/products/3082604-en-brother-hl-l2405w-printer"))
      .toEqual({ retailer: "staples", itemId: "3082604-en-brother-hl-l2405w-printer" });
  });
  it("routes a walmart.ca product URL to the walmart adapter", () => {
    expect(parseProductUrl("https://www.walmart.ca/en/ip/PlayStation-5-Pro-Console/1SZQHN3LOSE0"))
      .toEqual({ retailer: "walmart", itemId: "1SZQHN3LOSE0" });
  });
  it("treats a bare id as walmart", () => {
    expect(parseProductUrl("6000208927194")).toEqual({ retailer: "walmart", itemId: "6000208927194" });
  });
  it("returns null for an unsupported site", () => {
    expect(parseProductUrl("https://www.amazon.ca/dp/B0CQ5ZXG6R")).toBeNull();
    expect(parseProductUrl("")).toBeNull();
  });
  it("every adapter declares id, label, host, homeUrl and parseProductUrl", () => {
    for (const [key, a] of Object.entries(RETAILERS)) {
      expect(a.id).toBe(key);
      expect(typeof a.label).toBe("string");
      expect(a.host).toMatch(/^[a-z0-9.-]+$/);
      expect(a.homeUrl).toMatch(new RegExp(`^https://${a.host.replace(/\./g, "\\.")}/`));
      expect(typeof a.parseProductUrl).toBe("function");
    }
  });
});
