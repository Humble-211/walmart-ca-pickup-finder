import { describe, it, expect } from "vitest";
import { parseProductUrl, skuFromHandle } from "../src/retailers/staples/urls.js";

const HANDLE = "3082604-en-brother-hl-l2405w-home-office-ready-monochrome-laser-printer";

describe("staples parseProductUrl", () => {
  it("returns the full handle from an English product URL", () => {
    expect(parseProductUrl(`https://www.staples.ca/products/${HANDLE}`)).toBe(HANDLE);
  });
  it("accepts the /fr/ locale prefix and strips query strings and hashes", () => {
    expect(parseProductUrl(`https://www.staples.ca/fr/products/${HANDLE}?trk=product_clicked_trk_39723906269313#x`)).toBe(HANDLE);
  });
  it("accepts 5- and 8-digit skus", () => {
    expect(parseProductUrl("https://www.staples.ca/products/14336-en-staples-copy-paper")).toBe("14336-en-staples-copy-paper");
    expect(parseProductUrl("https://www.staples.ca/products/24501714-en-canon-pixma-tr4720")).toBe("24501714-en-canon-pixma-tr4720");
  });
  it("lower-cases an upper-cased pasted URL's handle", () => {
    expect(parseProductUrl(`https://www.staples.ca/products/${HANDLE.toUpperCase()}`)).toBe(HANDLE);
  });
  it("rejects bare ids, handles without a sku prefix, and other hosts", () => {
    expect(parseProductUrl("3082604")).toBeNull();
    expect(parseProductUrl("https://www.staples.ca/products/brother-printer")).toBeNull();
    expect(parseProductUrl("https://www.bestbuy.ca/en-ca/product/x/19446111")).toBeNull();
    expect(parseProductUrl("https://www.staples.ca/collections/printers")).toBeNull();
  });
});

describe("skuFromHandle", () => {
  it("returns the leading digits", () => {
    expect(skuFromHandle(HANDLE)).toBe("3082604");
    expect(skuFromHandle("14336-en-x")).toBe("14336");
  });
  it("returns null when the handle has no numeric prefix", () => {
    expect(skuFromHandle("brother-printer")).toBeNull();
    expect(skuFromHandle("")).toBeNull();
  });
});
