import { describe, it, expect } from "vitest";
import { rankStores } from "../src/lib/rank-stores.js";

const mk = (id, distanceKm) => ({ id, name: id, address: "", postalCode: "", distanceKm, status: "unknown", accessPointId: null });

describe("rankStores", () => {
  it("sorts by distance ascending", () => {
    const out = rankStores([mk("b", 5), mk("a", 1), mk("c", 3.2)]);
    expect(out.map((s) => s.id)).toEqual(["a", "c", "b"]);
  });
  it("puts null distances last and keeps their relative order", () => {
    const out = rankStores([mk("x", null), mk("a", 2), mk("y", null), mk("b", 1)]);
    expect(out.map((s) => s.id)).toEqual(["b", "a", "x", "y"]);
  });
  it("does not mutate the input", () => {
    const input = [mk("b", 2), mk("a", 1)];
    rankStores(input);
    expect(input.map((s) => s.id)).toEqual(["b", "a"]);
  });
});
