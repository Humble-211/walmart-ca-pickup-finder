import { describe, it, expect } from "vitest";
import { parseItemId } from "../src/lib/parse-item-id.js";

describe("parseItemId", () => {
  it("accepts a bare numeric id", () => {
    expect(parseItemId("6000208927194")).toBe("6000208927194");
  });
  it("trims whitespace around a bare id", () => {
    expect(parseItemId("  6000208927194\n")).toBe("6000208927194");
  });
  it("extracts id from an English product URL with slug", () => {
    expect(parseItemId("https://www.walmart.ca/en/ip/Bounty-Paper-Towel-8-Rolls/6000208927194")).toBe("6000208927194");
  });
  it("extracts id from a French product URL", () => {
    expect(parseItemId("https://www.walmart.ca/fr/ip/Bounty/6000208927194")).toBe("6000208927194");
  });
  it("extracts id from a URL without slug and with query string", () => {
    expect(parseItemId("https://www.walmart.ca/en/ip/6000208927194?athAsset=abc&athena=true")).toBe("6000208927194");
  });
  it("extracts id from a URL with trailing slash and hash", () => {
    expect(parseItemId("https://www.walmart.ca/en/ip/x/6000208927194/#reviews")).toBe("6000208927194");
  });
  it("returns null for empty input", () => {
    expect(parseItemId("")).toBeNull();
    expect(parseItemId("   ")).toBeNull();
  });
  it("returns null for junk", () => {
    expect(parseItemId("paper towels")).toBeNull();
    expect(parseItemId("https://www.walmart.ca/en/search?q=towel")).toBeNull();
  });
  it("returns null for too-short numbers", () => {
    expect(parseItemId("12345")).toBeNull();
  });
});
