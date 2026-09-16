import { describe, it, expect } from "vitest";
import { locatePostalCode } from "../src/lib/fsa.js";

describe("locatePostalCode", () => {
  it("returns the FSA centroid for a full postal code, with or without a space", () => {
    const a = locatePostalCode("M5V 3L9"), b = locatePostalCode("m5v3l9");
    expect(a).toEqual(b);
    expect(a.lat).toBeCloseTo(43.64, 1);
    expect(a.lon).toBeCloseTo(-79.4, 1);
  });
  it("covers every province's capital FSA", () => {
    for (const fsa of ["V8W", "T5K", "S4P", "R3C", "M7A", "G1R", "E3B", "B3J", "C1A", "A1C", "Y1A", "X1A"]) expect(locatePostalCode(fsa)).not.toBeNull();
  });
  it("returns null for unknown or malformed input", () => {
    expect(locatePostalCode("Z9Z 9Z9")).toBeNull();
    expect(locatePostalCode("")).toBeNull();
    expect(locatePostalCode(null)).toBeNull();
  });
});
