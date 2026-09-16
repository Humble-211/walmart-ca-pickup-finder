import { describe, it, expect, vi } from "vitest";
import { createWatcher, alertText, WATCHES_KEY, SETTINGS_KEY, DEFAULT_SETTINGS } from "../src/lib/watch.js";
import { createWatch } from "../src/lib/watch-entry.js";

const NOW = 1_700_000_000_000;
const MIN = 60_000;

function fakeStorage(initial = {}) {
  let data = { ...initial };
  return {
    get: vi.fn(async (keys) => {
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter((k) => k in data).map((k) => [k, data[k]]));
    }),
    set: vi.fn(async (patch) => { data = { ...data, ...patch }; }),
    read: () => data,
  };
}

const configured = { enabled: true, telegram: { token: "t", chatId: "c" }, intervalMinutes: 5 };
const item = (status) => ({ name: "PS5 Pro", url: "https://www.walmart.ca/x", priceString: "$827.00", delivery: { status, quantity: null, eta: null } });

function setup({ watches = [], settings = configured, job = null, answer = { ok: true, item: item("out_of_stock") }, notifyResult = { ok: true } } = {}) {
  const storage = fakeStorage({ [WATCHES_KEY]: watches, [SETTINGS_KEY]: settings });
  const forward = vi.fn(async () => answer);
  const notify = vi.fn(async () => notifyResult);
  const watcher = createWatcher({ forward, storage, getJob: async () => job, notify, now: () => NOW, random: () => 0.5 });
  return { watcher, storage, forward, notify };
}

const due = (over = {}) => ({ ...createWatch({ retailer: "walmart", itemId: "1", input: "u", postalCode: "T3A 5S8", now: NOW - MIN }), ...over });

describe("tick guards", () => {
  it("does nothing when the monitor is switched off", async () => {
    const { watcher, forward } = setup({ watches: [due()], settings: { ...configured, enabled: false } });
    expect(await watcher.tick()).toEqual({ checked: 0, skipped: "disabled" });
    expect(forward).not.toHaveBeenCalled();
  });

  it("does nothing until telegram is configured, so alerts cannot be silently lost", async () => {
    const { watcher, forward } = setup({ watches: [due()], settings: { ...configured, telegram: null } });
    expect(await watcher.tick()).toEqual({ checked: 0, skipped: "unconfigured" });
    expect(forward).not.toHaveBeenCalled();
  });

  it("stands aside while the user's own search is running, to leave the rate limit alone", async () => {
    for (const phase of ["lookup", "searching"]) {
      const { watcher, forward } = setup({ watches: [due()], job: { phase } });
      expect(await watcher.tick()).toEqual({ checked: 0, skipped: "busy" });
      expect(forward).not.toHaveBeenCalled();
    }
  });

  it("runs while a finished job is still on screen", async () => {
    const { watcher, forward } = setup({ watches: [due()], job: { phase: "done" } });
    expect((await watcher.tick()).checked).toBe(1);
    expect(forward).toHaveBeenCalledTimes(1);
  });

  it("checks nothing when no entry is due", async () => {
    const { watcher, forward } = setup({ watches: [due({ nextCheckAt: NOW + MIN })] });
    expect(await watcher.tick()).toEqual({ checked: 0, skipped: null });
    expect(forward).not.toHaveBeenCalled();
  });
});

describe("tick checking", () => {
  it("asks the retailer the delivery question the adapters already answer", async () => {
    const { watcher, forward } = setup({ watches: [due()] });
    await watcher.tick();
    expect(forward).toHaveBeenCalledWith({
      type: "lookup", retailer: "walmart", itemId: "1", postalCode: "T3A 5S8", mode: "delivery",
    });
  });

  it("stores the new status and the next due time", async () => {
    const { watcher, storage } = setup({ watches: [due()] });
    await watcher.tick();
    const [saved] = storage.read()[WATCHES_KEY];
    expect(saved).toMatchObject({ status: "out_of_stock", name: "PS5 Pro", failures: 0 });
    expect(saved.nextCheckAt).toBe(NOW + 5 * MIN);
  });

  it("checks at most three entries in one tick", async () => {
    const watches = ["1", "2", "3", "4"].map((id) => ({ ...due(), id: `walmart:${id}`, itemId: id }));
    const { watcher, forward } = setup({ watches });
    expect((await watcher.tick()).checked).toBe(3);
    expect(forward).toHaveBeenCalledTimes(3);
  });

  it("keeps going when one entry's forward throws", async () => {
    const watches = [{ ...due(), id: "walmart:1", itemId: "1" }, { ...due(), id: "walmart:2", itemId: "2" }];
    const storage = fakeStorage({ [WATCHES_KEY]: watches, [SETTINGS_KEY]: configured });
    const forward = vi.fn(async (msg) => { if (msg.itemId === "1") throw new Error("tab closed"); return { ok: true, item: item("out_of_stock") }; });
    const watcher = createWatcher({ forward, storage, getJob: async () => null, notify: async () => ({ ok: true }), now: () => NOW, random: () => 0.5 });
    expect((await watcher.tick()).checked).toBe(2);
    const saved = storage.read()[WATCHES_KEY];
    expect(saved.find((w) => w.itemId === "1").lastError).toEqual({ code: "unknown", message: "tab closed" });
    expect(saved.find((w) => w.itemId === "2").status).toBe("out_of_stock");
  });
});

describe("tick notifying", () => {
  it("sends the restock message and only then records that the user was told", async () => {
    const { watcher, notify, storage } = setup({ watches: [due()], answer: { ok: true, item: item("available") } });
    await watcher.tick();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toContain("PS5 Pro");
    expect(notify.mock.calls[0][0]).toContain("https://www.walmart.ca/x");
    expect(storage.read()[WATCHES_KEY][0].notifiedStatus).toBe("available");
  });

  it("retries on the next tick when telegram refused the message", async () => {
    const { watcher, notify, storage } = setup({ watches: [due()], answer: { ok: true, item: item("available") }, notifyResult: { ok: false, error: "chat not found" } });
    await watcher.tick();
    expect(storage.read()[WATCHES_KEY][0].status).toBe("available");
    expect(storage.read()[WATCHES_KEY][0].notifiedStatus).toBeNull();
    storage.read()[WATCHES_KEY][0].nextCheckAt = NOW - 1;
    await watcher.tick();
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("does not repeat itself while the item stays in stock", async () => {
    const { watcher, notify, storage } = setup({ watches: [due()], answer: { ok: true, item: item("available") } });
    await watcher.tick();
    storage.read()[WATCHES_KEY][0].nextCheckAt = NOW - 1;
    await watcher.tick();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("names the fix in the message when the retailer demands its bot check", async () => {
    const watches = [due({ failures: 2 })];
    const { watcher, notify } = setup({ watches, answer: { ok: false, code: "verification", error: "walmart.ca asked for verification." } });
    await watcher.tick();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toMatch(/verification/i);
  });

  it("does not let a throwing notifier lose the check result", async () => {
    const storage = fakeStorage({ [WATCHES_KEY]: [due()], [SETTINGS_KEY]: configured });
    const watcher = createWatcher({
      forward: async () => ({ ok: true, item: item("available") }), storage, getJob: async () => null,
      notify: async () => { throw new Error("boom"); }, now: () => NOW, random: () => 0.5,
    });
    expect((await watcher.tick()).checked).toBe(1);
    expect(storage.read()[WATCHES_KEY][0].status).toBe("available");
    expect(storage.read()[WATCHES_KEY][0].notifiedStatus).toBeNull();
  });
});

describe("watchlist management", () => {
  it("starts empty with the monitor off", async () => {
    const storage = fakeStorage();
    const watcher = createWatcher({ forward: vi.fn(), storage, getJob: async () => null, notify: vi.fn(), now: () => NOW, random: () => 0.5 });
    expect(await watcher.list()).toEqual({ watches: [], settings: DEFAULT_SETTINGS });
  });

  it("adds an entry that is due at once", async () => {
    const { watcher, storage } = setup();
    const w = await watcher.add({ retailer: "walmart", itemId: "1", input: "u", postalCode: "T3A 5S8" });
    expect(w).toMatchObject({ id: "walmart:1", nextCheckAt: NOW });
    expect(storage.read()[WATCHES_KEY]).toHaveLength(1);
  });

  it("updates rather than duplicates when the same product is added again", async () => {
    const { watcher, storage } = setup();
    await watcher.add({ retailer: "walmart", itemId: "1", input: "u", postalCode: "M5V 3L9" });
    await watcher.add({ retailer: "walmart", itemId: "1", input: "u2", postalCode: "T3A 5S8" });
    const saved = storage.read()[WATCHES_KEY];
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ postalCode: "T3A 5S8", input: "u2" });
  });

  it("removes and pauses by id", async () => {
    const { watcher, storage } = setup({ watches: [due()] });
    expect((await watcher.setPaused("walmart:1", true)).paused).toBe(true);
    expect(storage.read()[WATCHES_KEY][0].paused).toBe(true);
    await watcher.remove("walmart:1");
    expect(storage.read()[WATCHES_KEY]).toEqual([]);
  });

  it("merges settings instead of replacing them", async () => {
    const { watcher, storage } = setup();
    await watcher.setSettings({ enabled: false });
    expect(storage.read()[SETTINGS_KEY]).toEqual({ ...configured, enabled: false });
  });
});

describe("alertText", () => {
  const w = { name: "PS5 Pro", retailer: "walmart", priceString: "$827.00", url: "https://x", postalCode: "T3A 5S8", deliveryText: "Delivery to T3A 5S8: In stock", lastError: { code: "verification", message: "walmart.ca asked for verification." } };
  it("leads with the news and carries the link", () => {
    const text = alertText("restock", w);
    expect(text.startsWith("🟢 In stock — PS5 Pro")).toBe(true);
    expect(text).toContain("Delivery to T3A 5S8: In stock");
    expect(text).toContain("https://x");
  });
  it("says what broke and what to do about it", () => {
    expect(alertText("error", w)).toContain("walmart.ca asked for verification.");
  });
  it("closes the loop when checks work again", () => {
    expect(alertText("recovery", w)).toContain("PS5 Pro");
  });
});

describe("tick concurrency", () => {
  it("refuses to start a second tick while one is still running", async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const storage = fakeStorage({ [WATCHES_KEY]: [due()], [SETTINGS_KEY]: configured });
    const forward = vi.fn(async () => { await gate; return { ok: true, item: item("out_of_stock") }; });
    const watcher = createWatcher({ forward, storage, getJob: async () => null, notify: async () => ({ ok: true }), now: () => NOW, random: () => 0.5 });
    const first = watcher.tick();
    expect(await watcher.tick()).toEqual({ checked: 0, skipped: "running" });
    release();
    expect(await first).toEqual({ checked: 1, skipped: null });
    expect(forward).toHaveBeenCalledTimes(1);
  });

  it("keeps a watch added while a tick was in flight", async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const storage = fakeStorage({ [WATCHES_KEY]: [due({ id: "walmart:1" })], [SETTINGS_KEY]: configured });
    const forward = vi.fn(async () => { await gate; return { ok: true, item: item("out_of_stock") }; });
    const watcher = createWatcher({ forward, storage, getJob: async () => null, notify: async () => ({ ok: true }), now: () => NOW, random: () => 0.5 });
    const first = watcher.tick();
    // Add a new watch while the tick is in flight
    await watcher.add({ retailer: "bestbuy", itemId: "9", input: "u", postalCode: "T3A 5S8" });
    release();
    expect(await first).toEqual({ checked: 1, skipped: null });
    // Assert both watches are in the stored list
    const stored = storage.read()[WATCHES_KEY];
    expect(stored).toHaveLength(2);
    expect(stored.map((w) => w.id).sort()).toEqual(["bestbuy:9", "walmart:1"]);
    // Assert the checked entry got its new status
    expect(stored.find((w) => w.id === "walmart:1").status).toBe("out_of_stock");
  });

  it("does not resurrect a watch removed while a tick was in flight", async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const storage = fakeStorage({ [WATCHES_KEY]: [due({ id: "walmart:1" })], [SETTINGS_KEY]: configured });
    const forward = vi.fn(async () => { await gate; return { ok: true, item: item("out_of_stock") }; });
    const watcher = createWatcher({ forward, storage, getJob: async () => null, notify: async () => ({ ok: true }), now: () => NOW, random: () => 0.5 });
    const first = watcher.tick();
    // Remove the watch while the tick is in flight
    await watcher.remove("walmart:1");
    release();
    expect(await first).toEqual({ checked: 1, skipped: null });
    // Assert the watch was not resurrected
    const stored = storage.read()[WATCHES_KEY];
    expect(stored).toEqual([]);
  });

  it("releases the guard after a tick throws, so the monitor is not wedged", async () => {
    const storage = fakeStorage({ [WATCHES_KEY]: [due()], [SETTINGS_KEY]: configured });
    // Make storage.get reject once, then work normally
    let callCount = 0;
    const originalGet = storage.get;
    storage.get = vi.fn(async (keys) => {
      callCount++;
      if (callCount === 1) throw new Error("storage error");
      return originalGet.call(storage, keys);
    });
    const watcher = createWatcher({ forward: async () => ({ ok: true, item: item("out_of_stock") }), storage, getJob: async () => null, notify: async () => ({ ok: true }), now: () => NOW, random: () => 0.5 });
    // First tick throws
    await expect(watcher.tick()).rejects.toThrow("storage error");
    // Second tick should work normally (guard is released)
    expect((await watcher.tick()).checked).toBe(1);
  });
});
