import { describe, it, expect, vi } from "vitest";
import { handleMessage } from "../src/retailers/walmart/content.js";

const item = { id: "1", name: "Thing", url: "https://www.walmart.ca/en/ip/1", retailer: "walmart", pickupEligible: true, soldByThirdParty: false, sellerName: "Walmart", shipping: null };
const thirdParty = { ...item, pickupEligible: false, soldByThirdParty: true, sellerName: "Growcanada", shipping: { status: "available", quantity: null, eta: "arrives Sep 21" } };
const store = (id, status) => ({ id, name: id, address: "", postalCode: "", distanceKm: Number(id), status, url: null, accessPointId: "ap" + id });

describe("walmart delivery mode", () => {
  it("looks up delivery nodes and summarises them, without touching the pickup store list", async () => {
    const deps = {
      getItem: vi.fn(async () => item),
      findStores: vi.fn(),
      findDeliveryStores: vi.fn(async () => [store("2", "out_of_stock"), store("1", "available")]),
    };
    const res = await handleMessage({ type: "lookup", itemId: "1", postalCode: "M5V 3L9", mode: "delivery" }, deps);
    expect(deps.findStores).not.toHaveBeenCalled();
    expect(deps.findDeliveryStores).toHaveBeenCalledWith("M5V 3L9", "1", 10);
    expect(res.item.delivery).toEqual({ status: "available", quantity: null, eta: null });
    expect(res.stores.map((s) => s.id)).toEqual(["1", "2"]); // ranked by distance
    expect(res.complete).toBe(false); // the node count can still be widened
  });

  it("widens the node count on findInStock and then reports complete", async () => {
    const deps = {
      findDeliveryStores: vi.fn(async () => [store("1", "available"), store("2", "out_of_stock")]),
    };
    const res = await handleMessage({ type: "findInStock", itemId: "1", postalCode: "M5V 3L9", mode: "delivery", nearby: [] }, deps);
    expect(deps.findDeliveryStores).toHaveBeenCalledWith("M5V 3L9", "1", 50);
    expect(res.inStock.map((s) => s.id)).toEqual(["1"]);
    expect(res.complete).toBe(true);
    expect(res.checkedIds).toEqual(["1", "2"]);
    expect(res.delivery).toEqual({ status: "available", quantity: null, eta: null }); // reflects the widened node list, not the stale first-10 answer
  });

  // walmart's delivery nodes are its own stores; they never stock a marketplace seller's item,
  // so listing them would show ten "Out of stock" rows for an item that ships tomorrow.
  it("answers a third-party offer from the offer itself and lists no walmart nodes", async () => {
    const deps = {
      getItem: vi.fn(async () => thirdParty),
      findDeliveryStores: vi.fn(async () => [store("1", "out_of_stock"), store("2", "out_of_stock")]),
    };
    const res = await handleMessage({ type: "lookup", itemId: "1", postalCode: "L4K 0P8", mode: "delivery" }, deps);
    expect(res.item.delivery).toEqual({ status: "available", quantity: null, eta: "arrives Sep 21", seller: "Growcanada" });
    expect(res.stores).toEqual([]);
    expect(res.complete).toBe(true); // there is nothing farther to widen to
  });

  it("does not widen the node search for a third-party offer", async () => {
    const deps = { findDeliveryStores: vi.fn(async () => [store("1", "out_of_stock")]) };
    const res = await handleMessage({ type: "findInStock", itemId: "1", postalCode: "L4K 0P8", mode: "delivery", nearby: [], item: thirdParty }, deps);
    expect(deps.findDeliveryStores).not.toHaveBeenCalled();
    expect(res.delivery.status).toBe("available");
    expect(res.inStock).toEqual([]);
    expect(res.complete).toBe(true);
  });

  it("leaves pickup mode alone", async () => {
    const deps = {
      getItem: vi.fn(async () => item),
      findStores: vi.fn(async () => [store("1", "available")]),
      findDeliveryStores: vi.fn(),
    };
    const res = await handleMessage({ type: "lookup", itemId: "1", postalCode: "M5V 3L9", mode: "pickup" }, deps);
    expect(deps.findStores).toHaveBeenCalledWith("M5V 3L9", "1", 10);
    expect(deps.findDeliveryStores).not.toHaveBeenCalled();
    expect(res.item.delivery).toBeUndefined();
  });
});
