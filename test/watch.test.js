import { describe, it, expect, vi } from "vitest";
import { createWatcher, alertText, rateNote, telegramSettings, WATCHES_KEY, SETTINGS_KEY, DEFAULT_SETTINGS } from "../src/lib/watch.js";
import { createWatch } from "../src/lib/watch-entry.js";
import { ERROR_MESSAGES } from "../src/lib/errors.js";

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

  // The content script sends the template, not the finished sentence: every code the
  // monitor can see carries {host}. Feeding the real constant through is what catches an
  // alert that reads "{host} asked for verification."
  it("sends and stores a message with no {placeholder} left in it", async () => {
    for (const code of ["no_tab", "verification", "rate_limited"]) {
      const { watcher, notify, storage } = setup({
        watches: [due({ failures: 2 })],
        answer: { ok: false, code, error: ERROR_MESSAGES[code] },
      });
      await watcher.tick();
      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify.mock.calls[0][0]).not.toContain("{");
      expect(notify.mock.calls[0][0]).toContain("www.walmart.ca");
      expect(storage.read()[WATCHES_KEY][0].lastError.message).not.toContain("{");
    }
  });

  // applyResult leaves alertedError up until a send is confirmed, so an outage at the
  // moment checks start working again costs a retry rather than the message.
  it("resends the recovery note on the next tick when telegram was unreachable", async () => {
    const storage = fakeStorage({ [WATCHES_KEY]: [due({ failures: 4, alertedError: true })], [SETTINGS_KEY]: configured });
    let accept = false;
    const notify = vi.fn(async () => (accept ? { ok: true } : { ok: false, error: "network" }));
    const watcher = createWatcher({
      forward: async () => ({ ok: true, item: item("out_of_stock") }), storage,
      getJob: async () => null, notify, now: () => NOW, random: () => 0.5,
    });
    await watcher.tick();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(storage.read()[WATCHES_KEY][0].alertedError).toBe(true); // the latch survived the failed send

    accept = true;
    storage.read()[WATCHES_KEY][0].nextCheckAt = NOW - 1;
    await watcher.tick();
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls[1][0]).toContain("Checks working again");
    expect(storage.read()[WATCHES_KEY][0].alertedError).toBe(false);

    // ...and once it lands, the note is not repeated on every later success.
    storage.read()[WATCHES_KEY][0].nextCheckAt = NOW - 1;
    await watcher.tick();
    expect(notify).toHaveBeenCalledTimes(2);
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

  // "Minutes between checks for each item" has to mean the items already on the list.
  it("applies a new interval to the entries already being watched", async () => {
    const { watcher, storage } = setup({ watches: [due({ id: "walmart:1" }), due({ id: "walmart:2", itemId: "2" })] });
    await watcher.setSettings({ intervalMinutes: 12 });
    expect(storage.read()[WATCHES_KEY].map((w) => w.intervalMinutes)).toEqual([12, 12]);
    // The next check after the change uses it.
    await watcher.tick();
    expect(storage.read()[WATCHES_KEY][0].nextCheckAt).toBe(NOW + 12 * MIN);
  });

  it("leaves the watchlist alone when the interval did not change", async () => {
    const { watcher, storage } = setup({ watches: [due({ id: "walmart:1" })] });
    await watcher.setSettings({ enabled: false });
    expect(storage.read()[WATCHES_KEY][0].intervalMinutes).toBe(5);
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

  // A check can run for the better part of a minute (tab open, three forward attempts).
  // Everything the user changes in that window lives in the stored list, and the tick's
  // snapshot is stale, so folding the snapshot back wholesale silently undid the edit.
  it("keeps a pause made while a tick was in flight", async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const storage = fakeStorage({ [WATCHES_KEY]: [due({ id: "walmart:1" })], [SETTINGS_KEY]: configured });
    const forward = vi.fn(async () => { await gate; return { ok: true, item: item("out_of_stock") }; });
    const watcher = createWatcher({ forward, storage, getJob: async () => null, notify: async () => ({ ok: true }), now: () => NOW, random: () => 0.5 });
    const first = watcher.tick();
    await watcher.setPaused("walmart:1", true);
    release();
    expect(await first).toEqual({ checked: 1, skipped: null });
    const [stored] = storage.read()[WATCHES_KEY];
    expect(stored.paused).toBe(true);
    expect(stored.status).toBe("out_of_stock"); // the check's own findings are still kept
  });

  it("keeps a postal code changed while a tick was in flight, and re-checks against it", async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const storage = fakeStorage({ [WATCHES_KEY]: [due({ id: "walmart:1" })], [SETTINGS_KEY]: configured });
    const forward = vi.fn(async () => { await gate; return { ok: true, item: item("out_of_stock") }; });
    const watcher = createWatcher({ forward, storage, getJob: async () => null, notify: async () => ({ ok: true }), now: () => NOW, random: () => 0.5 });
    const first = watcher.tick();
    await watcher.add({ retailer: "walmart", itemId: "1", input: "u2", postalCode: "M5V 3L9" });
    release();
    expect(await first).toEqual({ checked: 1, skipped: null });
    const [stored] = storage.read()[WATCHES_KEY];
    expect(stored).toMatchObject({ postalCode: "M5V 3L9", input: "u2", paused: false });
    // The answer that just came back is about the old address, so the entry stays due now
    // instead of being pushed five minutes out carrying an answer for the wrong destination.
    expect(stored.nextCheckAt).toBe(NOW);
  });

  it("keeps an interval change made while a tick was in flight", async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const storage = fakeStorage({ [WATCHES_KEY]: [due({ id: "walmart:1" })], [SETTINGS_KEY]: configured });
    const forward = vi.fn(async () => { await gate; return { ok: true, item: item("out_of_stock") }; });
    const watcher = createWatcher({ forward, storage, getJob: async () => null, notify: async () => ({ ok: true }), now: () => NOW, random: () => 0.5 });
    const first = watcher.tick();
    await watcher.setSettings({ intervalMinutes: 15 });
    release();
    await first;
    expect(storage.read()[WATCHES_KEY][0].intervalMinutes).toBe(15);
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

// The options page leans on this number as the safeguard against a long watchlist
// crossing walmart's rate limit, so it has to describe what the monitor really does.
describe("rateNote", () => {
  const w = (over = {}) => ({ retailer: "walmart", paused: false, intervalMinutes: 5, failures: 0, ...over });

  it("says so when nothing is being checked", () => {
    expect(rateNote([])).toBe("Nothing is being checked.");
    expect(rateNote([w({ paused: true })])).toBe("Nothing is being checked.");
    expect(rateNote(undefined)).toBe("Nothing is being checked.");
  });

  it("sums each entry's own interval rather than one global default", () => {
    // One entry every 5 minutes and one every minute: 1 + 5 = 6 checks per 5 minutes.
    expect(rateNote([w(), w({ intervalMinutes: 1 })])).toContain("About 6.0 Walmart checks every 5 minutes");
    expect(rateNote([w()])).toContain("About 1.0 Walmart checks every 5 minutes");
  });

  it("counts only walmart entries, because it is walmart's limit being described", () => {
    expect(rateNote([w(), w({ retailer: "bestbuy", intervalMinutes: 1 }), w({ retailer: "staples", intervalMinutes: 1 })]))
      .toContain("About 1.0 Walmart checks");
    expect(rateNote([w({ retailer: "bestbuy" }), w({ retailer: "shoppers" })]))
      .toBe("2 items being checked, none of them on Walmart.");
    expect(rateNote([w({ retailer: "bestbuy" })])).toBe("1 item being checked, none of them on Walmart.");
  });

  it("counts an entry in backoff at the interval it is actually using", () => {
    // 5 minutes doubled twice is 20, so a quarter of the healthy rate.
    expect(rateNote([w({ failures: 2 })])).toContain("About 0.3 Walmart checks");
  });

  it("names walmart's limit and survives a missing or zero interval", () => {
    expect(rateNote([w()])).toContain("Walmart starts refusing at roughly 25");
    expect(rateNote([w({ intervalMinutes: 0 })])).toContain("About 1.0 Walmart checks");
    expect(rateNote([w({ intervalMinutes: undefined })])).toContain("About 1.0 Walmart checks");
  });
});

// Regression: entering the token and moving to the next field emptied the token
// field and left telegram null forever, so the form could never be filled. The
// page renders back whatever was stored, so storing null the moment one side was
// empty erased what had just been typed.
describe("telegramSettings", () => {
  it("keeps a half-filled pair, so the page renders back what was typed", () => {
    expect(telegramSettings("123456:ABC", "")).toEqual({ token: "123456:ABC", chatId: "" });
    expect(telegramSettings("", "999")).toEqual({ token: "", chatId: "999" });
  });

  it("is null only when the user has typed nothing at all", () => {
    expect(telegramSettings("", "")).toBeNull();
    expect(telegramSettings("   ", " ")).toBeNull();
    expect(telegramSettings(null, undefined)).toBeNull();
  });

  it("trims what it stores, so a pasted token with a stray space still works", () => {
    expect(telegramSettings("  123456:ABC  ", " 999 ")).toEqual({ token: "123456:ABC", chatId: "999" });
  });

  it("leaves a half-filled pair unconfigured, so the monitor does not start on a broken credential", async () => {
    const half = { enabled: true, telegram: telegramSettings("123456:ABC", ""), intervalMinutes: 5 };
    const { watcher, forward } = setup({ watches: [due()], settings: half });
    expect(await watcher.tick()).toEqual({ checked: 0, skipped: "unconfigured" });
    expect(forward).not.toHaveBeenCalled();
  });
});
