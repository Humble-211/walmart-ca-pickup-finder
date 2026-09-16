import { describe, it, expect, vi } from "vitest";
import { handleMessage } from "../src/retailers/walmart/content.js";

const item = { id: "1", name: "Thing", url: "https://www.walmart.ca/en/ip/1", retailer: "walmart", pickupEligible: true };
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
