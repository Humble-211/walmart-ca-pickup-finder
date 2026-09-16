import { describe, it, expect } from "vitest";
import {
  DEFAULT_INTERVAL_MINUTES, MAX_BACKOFF_MINUTES, MAX_CHECKS_PER_TICK, ERROR_ALERT_AFTER,
  watchId, createWatch, backoffMinutes, nextCheckAt, dueWatches, applyResult, confirmAlert,
} from "../src/lib/watch-entry.js";
import { ERROR_MESSAGES } from "../src/lib/errors.js";

const NOW = 1_700_000_000_000;
const MIN = 60_000;
const base = (over = {}) => ({ ...createWatch({ retailer: "walmart", itemId: "1", input: "u", postalCode: "M5V 3L9", now: NOW }), ...over });
const okResult = (status, over = {}) => ({ ok: true, item: { name: "Thing", url: "https://x/1", priceString: "$1", delivery: { status, quantity: null, eta: null }, ...over } });

describe("createWatch", () => {
  it("is due immediately and knows nothing yet", () => {
    const w = createWatch({ retailer: "walmart", itemId: "1", input: "u", postalCode: "M5V 3L9", now: NOW });
    expect(w).toMatchObject({
      id: "walmart:1", retailer: "walmart", itemId: "1", input: "u", postalCode: "M5V 3L9",
      name: null, url: null, priceString: null, status: null, notifiedStatus: null, deliveryText: null,
      lastCheckedAt: null, nextCheckAt: NOW, failures: 0, lastError: null, alertedError: false,
      notifiedAt: null, paused: false, createdAt: NOW, intervalMinutes: DEFAULT_INTERVAL_MINUTES,
    });
  });
  it("builds the same id for the same product, so re-adding is idempotent", () => {
    expect(watchId("walmart", "1")).toBe("walmart:1");
    expect(createWatch({ retailer: "walmart", itemId: "1", input: "a", postalCode: "P", now: NOW }).id)
      .toBe(createWatch({ retailer: "walmart", itemId: "1", input: "b", postalCode: "Q", now: NOW }).id);
  });
});

describe("backoffMinutes", () => {
  it("doubles per consecutive failure and caps", () => {
    expect(backoffMinutes(5, 0)).toBe(5);
    expect(backoffMinutes(5, 1)).toBe(10);
    expect(backoffMinutes(5, 3)).toBe(40);
    expect(backoffMinutes(5, 10)).toBe(MAX_BACKOFF_MINUTES);
  });
});

describe("nextCheckAt", () => {
  it("applies jitter between 0.75 and 1.25 of the interval", () => {
    expect(nextCheckAt({ now: NOW, intervalMinutes: 4, failures: 0, random: () => 0 })).toBe(NOW + 4 * MIN * 0.75);
    expect(nextCheckAt({ now: NOW, intervalMinutes: 4, failures: 0, random: () => 0.5 })).toBe(NOW + 4 * MIN * 1.0);
    expect(nextCheckAt({ now: NOW, intervalMinutes: 4, failures: 0, random: () => 1 })).toBe(NOW + 4 * MIN * 1.25);
  });
  it("uses the backed-off interval after failures", () => {
    expect(nextCheckAt({ now: NOW, intervalMinutes: 5, failures: 2, random: () => 0.5 })).toBe(NOW + 20 * MIN);
  });
});

describe("dueWatches", () => {
  const w = (id, nextCheckAt, over = {}) => ({ ...base(), id, nextCheckAt, ...over });
  it("returns only unpaused entries whose time has come, oldest due first", () => {
    const list = [w("a", NOW), w("b", NOW - 1000), w("c", NOW + 1000), w("d", NOW - 5000, { paused: true })];
    expect(dueWatches(list, NOW, 10).map((x) => x.id)).toEqual(["b", "a"]);
  });
  it("caps how many one tick may check", () => {
    const list = [w("a", NOW - 4), w("b", NOW - 3), w("c", NOW - 2), w("d", NOW - 1)];
    expect(dueWatches(list, NOW, MAX_CHECKS_PER_TICK)).toHaveLength(3);
    expect(dueWatches(list, NOW).map((x) => x.id)).toEqual(["a", "b", "c"]);
  });
});

describe("applyResult on a successful check", () => {
  it("records what the retailer said and schedules the next check", () => {
    const { watch } = applyResult(base(), okResult("out_of_stock"), { now: NOW, random: () => 0.5 });
    expect(watch).toMatchObject({
      status: "out_of_stock", name: "Thing", url: "https://x/1", priceString: "$1",
      lastCheckedAt: NOW, failures: 0, lastError: null,
    });
    expect(watch.nextCheckAt).toBe(NOW + DEFAULT_INTERVAL_MINUTES * MIN);
  });

  it("alerts the first time an item is deliverable, even on the very first check", () => {
    const { watch, alert } = applyResult(base(), okResult("available"), { now: NOW, random: () => 0.5 });
    expect(alert).toBe("restock");
    expect(watch.status).toBe("available");
    expect(watch.notifiedStatus).toBeNull(); // only confirmAlert moves this, after telegram accepts
  });

  it("stays quiet while the item remains deliverable", () => {
    const told = base({ status: "available", notifiedStatus: "available" });
    expect(applyResult(told, okResult("available"), { now: NOW, random: () => 0.5 }).alert).toBeNull();
  });

  it("follows the status down without a message, so the next return alerts again", () => {
    const told = base({ status: "available", notifiedStatus: "available" });
    const gone = applyResult(told, okResult("out_of_stock"), { now: NOW, random: () => 0.5 });
    expect(gone.alert).toBeNull();
    expect(gone.watch.notifiedStatus).toBe("out_of_stock");
    expect(applyResult(gone.watch, okResult("available"), { now: NOW, random: () => 0.5 }).alert).toBe("restock");
  });

  it("treats an unknown answer as not deliverable and does not alert", () => {
    expect(applyResult(base(), okResult("unknown"), { now: NOW, random: () => 0.5 }).alert).toBeNull();
  });

  it("keeps the retailer's own delivery wording for the message and the options page", () => {
    const res = okResult("available", { delivery: { status: "available", quantity: null, eta: "arrives Sep 21", seller: "DealWiz" } });
    expect(applyResult(base(), res, { now: NOW, random: () => 0.5 }).watch.deliveryText)
      .toBe("Ships from DealWiz: In stock · arrives Sep 21");
  });

  it("treats a missing delivery block as unknown rather than crashing", () => {
    const { watch, alert } = applyResult(base(), { ok: true, item: { name: "T", url: "u", priceString: "$1" } }, { now: NOW, random: () => 0.5 });
    expect(watch.status).toBe("unknown");
    expect(alert).toBeNull();
  });
});

describe("applyResult on a failed check", () => {
  const err = { ok: false, code: "verification", error: "walmart.ca asked for verification." };

  it("counts the failure, stores it, and backs off", () => {
    const { watch, alert } = applyResult(base(), err, { now: NOW, random: () => 0.5 });
    expect(alert).toBeNull();
    expect(watch.failures).toBe(1);
    expect(watch.lastError).toEqual({ code: "verification", message: "walmart.ca asked for verification." });
    expect(watch.nextCheckAt).toBe(NOW + 10 * MIN); // 5 * 2**1
    expect(watch.status).toBe(null); // a failed check tells us nothing about stock
  });

  // The wire carries the raw template: every code the monitor sees (no_tab, verification,
  // rate_limited) contains {host}, and nothing downstream substitutes it, so the Telegram
  // message used to read "{host} asked for verification".
  it("renders the retailer into the stored message, leaving no placeholder behind", () => {
    for (const code of ["no_tab", "verification", "rate_limited"]) {
      const { watch } = applyResult(base(), { ok: false, code, error: ERROR_MESSAGES[code] }, { now: NOW, random: () => 0.5 });
      expect(watch.lastError.message).not.toContain("{");
      expect(watch.lastError.message).toContain("www.walmart.ca");
    }
    const bestbuy = { ...base(), retailer: "bestbuy" };
    const { watch } = applyResult(bestbuy, { ok: false, code: "verification", error: ERROR_MESSAGES.verification }, { now: NOW, random: () => 0.5 });
    expect(watch.lastError.message).toBe("www.bestbuy.ca asked for verification. Complete it in the www.bestbuy.ca tab, then retry.");
  });

  it("alerts exactly once, on the third consecutive failure", () => {
    expect(applyResult(base({ failures: 1 }), err, { now: NOW, random: () => 0.5 }).alert).toBeNull();
    expect(applyResult(base({ failures: ERROR_ALERT_AFTER - 1 }), err, { now: NOW, random: () => 0.5 }).alert).toBe("error");
    expect(applyResult(base({ failures: 9, alertedError: true }), err, { now: NOW, random: () => 0.5 }).alert).toBeNull();
  });

  it("says checks are working again after an error streak, and only then", () => {
    const recovered = applyResult(base({ failures: 5, alertedError: true }), okResult("out_of_stock"), { now: NOW, random: () => 0.5 });
    expect(recovered.alert).toBe("recovery");
    expect(recovered.watch.failures).toBe(0);
    // The latch stays up until confirmAlert sees the note accepted: clearing it here
    // would drop the message for good if Telegram happened to be unreachable.
    expect(recovered.watch.alertedError).toBe(true);
    expect(applyResult(base(), okResult("out_of_stock"), { now: NOW, random: () => 0.5 }).alert).toBeNull();
  });

  it("keeps asking for the recovery note until one send is accepted", () => {
    const failed = applyResult(base({ failures: 5, alertedError: true }), okResult("out_of_stock"), { now: NOW, random: () => 0.5 });
    // Telegram refused, so nothing was confirmed: the next successful check asks again.
    const again = applyResult(failed.watch, okResult("out_of_stock"), { now: NOW, random: () => 0.5 });
    expect(again.alert).toBe("recovery");
    expect(applyResult(confirmAlert(again.watch, "recovery"), okResult("out_of_stock"), { now: NOW, random: () => 0.5 }).alert).toBeNull();
  });

  it("prefers the restock news over the recovery note when both apply", () => {
    const both = applyResult(base({ failures: 5, alertedError: true }), okResult("available"), { now: NOW, random: () => 0.5 });
    expect(both.alert).toBe("restock");
    expect(both.watch.alertedError).toBe(false);
  });
});

describe("confirmAlert", () => {
  it("advances the told-status only after a restock message was accepted", () => {
    const w = base({ status: "available", notifiedStatus: null });
    expect(confirmAlert(w, "restock")).toMatchObject({ notifiedStatus: "available" });
  });
  it("marks the error streak as reported", () => {
    expect(confirmAlert(base({ failures: 3 }), "error").alertedError).toBe(true);
  });
  it("lowers the error latch once the recovery note was accepted", () => {
    const w = base({ status: "out_of_stock", notifiedStatus: "out_of_stock", alertedError: true });
    expect(confirmAlert(w, "recovery")).toEqual({ ...w, alertedError: false });
  });
  it("leaves the entry alone when there was no alert", () => {
    const w = base({ status: "out_of_stock", notifiedStatus: "out_of_stock" });
    expect(confirmAlert(w, null)).toEqual(w);
  });
});
