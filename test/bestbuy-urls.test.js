import { describe, it, expect } from "vitest";
import { parseProductUrl } from "../src/retailers/bestbuy/urls.js";

describe("bestbuy parseProductUrl", () => {
  it("extracts the sku from an English product URL", () => {
    expect(parseProductUrl("https://www.bestbuy.ca/en-ca/product/playstation-5-pro-console/18291446")).toBe("18291446");
  });
  it("extracts the sku from a French URL with query string", () => {
    expect(parseProductUrl("https://www.bestbuy.ca/fr-ca/produit/console-playstation-5-pro/18291446?icmp=x")).toBe("18291446");
  });
  it("rejects bare ids and other hosts", () => {
    expect(parseProductUrl("18291446")).toBeNull();
    expect(parseProductUrl("https://www.walmart.ca/en/ip/x/6000208927194")).toBeNull();
  });
});
