import { describe, it, expect } from "vitest";
import { deliveryText } from "../src/lib/delivery.js";

describe("deliveryText", () => {
  it("shows status, quantity and the retailer's own eta wording", () => {
    expect(deliveryText({ status: "available", quantity: 56, eta: "Estimated delivery in 1-3 business days" }, "M5V 3L9"))
      .toBe("Delivery to M5V 3L9: In stock · 56 available · Estimated delivery in 1-3 business days");
    expect(deliveryText({ status: "available", quantity: 30, eta: "arrives Sep 22" }, "M5V 3L9"))
      .toBe("Delivery to M5V 3L9: In stock · 30 available · arrives Sep 22");
  });
  it("omits the quantity unless the item is in stock, and the eta when there is none", () => {
    expect(deliveryText({ status: "out_of_stock", quantity: 0, eta: null }, "M5V 3L9")).toBe("Delivery to M5V 3L9: Out of stock");
    expect(deliveryText({ status: "unknown", quantity: null, eta: null }, "M5V 3L9")).toBe("Delivery to M5V 3L9: Unknown");
    expect(deliveryText({ status: "available", quantity: null, eta: null }, "M5V 3L9")).toBe("Delivery to M5V 3L9: In stock");
  });
  it("returns nothing for an adapter that does not report delivery", () => {
    expect(deliveryText(null, "M5V 3L9")).toBe("");
    expect(deliveryText(undefined, "M5V 3L9")).toBe("");
  });
  it("falls back to 'you' without a postal code", () => {
    expect(deliveryText({ status: "available", quantity: null, eta: null }, "")).toBe("Delivery to you: In stock");
  });
});
