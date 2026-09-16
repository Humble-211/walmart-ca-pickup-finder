import { describe, it, expect } from "vitest";
import { shortDate, dateRange } from "../src/lib/dates.js";

describe("shortDate / dateRange", () => {
  it("formats an ISO date as month and day", () => {
    expect(shortDate("2026-09-22T09:00:00")).toBe("Sep 22");
  });
  it("returns null for missing or invalid input", () => {
    expect(shortDate(null)).toBeNull();
    expect(shortDate("soon")).toBeNull();
  });
  it("collapses a same-day window and joins a multi-day one", () => {
    expect(dateRange("2026-09-22T09:00:00", "2026-09-22T17:00:00")).toBe("Sep 22");
    expect(dateRange("2026-09-17T09:00:00", "2026-09-22T17:00:00")).toBe("Sep 17 – Sep 22");
    expect(dateRange(null, "2026-09-22T17:00:00")).toBe("Sep 22");
    expect(dateRange(null, null)).toBeNull();
  });
});
