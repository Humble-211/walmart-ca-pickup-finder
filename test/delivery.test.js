import { describe, it, expect } from "vitest";
import { deliveryText, deliveryModeStatus } from "../src/lib/delivery.js";

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
  it("names the seller when the item ships from a marketplace seller rather than the retailer", () => {
    expect(deliveryText({ status: "available", quantity: null, eta: "arrives Sep 21", seller: "Growcanada" }, "L4K 0P8"))
      .toBe("Delivery to L4K 0P8: In stock · arrives Sep 21 · Ships from Growcanada");
    expect(deliveryText({ status: "out_of_stock", quantity: null, eta: null, seller: "Growcanada" }, "L4K 0P8"))
      .toBe("Delivery to L4K 0P8: Out of stock · Ships from Growcanada");
  });

  it("returns nothing for an adapter that does not report delivery", () => {
    expect(deliveryText(null, "M5V 3L9")).toBe("");
    expect(deliveryText(undefined, "M5V 3L9")).toBe("");
  });
  it("falls back to 'you' without a postal code", () => {
    expect(deliveryText({ status: "available", quantity: null, eta: null }, "")).toBe("Delivery to you: In stock");
  });
});

describe("deliveryModeStatus", () => {
  const item = { name: "Thing", delivery: { status: "available", quantity: 5, eta: null } };
  it("says nothing when the item can be delivered", () => {
    expect(deliveryModeStatus(item, "M5V 3L9")).toBe("");
  });
  it("says so plainly when it cannot be delivered", () => {
    expect(deliveryModeStatus({ ...item, delivery: { status: "out_of_stock", quantity: 0, eta: null } }, "M5V 3L9"))
      .toBe("This item cannot be delivered to M5V 3L9.");
  });
  it("blames the seller, not the postal code, when a marketplace offer is out of stock", () => {
    expect(deliveryModeStatus({ ...item, delivery: { status: "out_of_stock", quantity: null, eta: null, seller: "DealWiz" } }, "T3A 5S8"))
      .toBe("DealWiz has this out of stock.");
  });

  it("says the retailer did not answer when the status is unknown or missing", () => {
    expect(deliveryModeStatus({ ...item, delivery: { status: "unknown", quantity: null, eta: null } }, "M5V 3L9"))
      .toBe("This store did not say whether it delivers to M5V 3L9.");
    expect(deliveryModeStatus({ ...item, delivery: null }, "M5V 3L9"))
      .toBe("This store did not say whether it delivers to M5V 3L9.");
  });
  it("says nothing without an item", () => {
    expect(deliveryModeStatus(null, "M5V 3L9")).toBe("");
  });
});
