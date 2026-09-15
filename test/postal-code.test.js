import { describe, it, expect } from "vitest";
import { normalizePostalCode } from "../src/lib/postal-code.js";

describe("normalizePostalCode", () => {
  it("keeps a well-formed code", () => {
    expect(normalizePostalCode("M1P 4P5")).toBe("M1P 4P5");
  });
  it("uppercases and inserts the space", () => {
    expect(normalizePostalCode("m1p4p5")).toBe("M1P 4P5");
  });
  it("trims surrounding whitespace", () => {
    expect(normalizePostalCode("  m1p 4p5 ")).toBe("M1P 4P5");
  });
  it("rejects wrong shapes", () => {
    expect(normalizePostalCode("")).toBeNull();
    expect(normalizePostalCode("12345")).toBeNull();
    expect(normalizePostalCode("M1P4P")).toBeNull();
    expect(normalizePostalCode("M1P  4P5")).toBeNull();
    expect(normalizePostalCode("ZZZ 999")).toBeNull();
  });
});
