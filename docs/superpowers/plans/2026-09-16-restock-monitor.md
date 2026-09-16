# Restock Monitor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Watch a list of products on a timer and send a Telegram message when one becomes deliverable to the user's postal code.

**Architecture:** A `chrome.alarms` tick wakes the service worker every minute. A pure runner in `src/lib/watch.js` picks the entries that are due, sends the same delivery-mode `lookup` message every retailer adapter already answers, compares the new status with the stored one, and hands any alert to an injected notifier. Scheduling and transition rules live in `src/lib/watch-entry.js` as pure functions, so every rule is unit-tested without a browser, a network, or a real clock.

**Tech Stack:** Chrome extension MV3, plain ES modules, esbuild bundling, vitest for tests. No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-09-16-restock-monitor-design.md`

## Global Constraints

- No new runtime dependencies. `package.json` gains nothing.
- Every new logic module takes its dependencies as injected parameters, the way `createJobs({ forward, storage, now })` does in `src/lib/job.js`. Tests never touch the network, `chrome`, or the wall clock.
- Watchlist and settings live in `chrome.storage.local`. The foreground job keeps using `chrome.storage.session` and must not change.
- The existing pickup and delivery paths must not change behaviour. All 252 existing tests must still pass at every commit.
- `MAX_CHECKS_PER_TICK = 3`, base interval default `5` minutes, jitter range `0.75` to `1.25`, backoff cap `60` minutes, error alert after `3` consecutive failures. These exact values come from the spec.
- Telegram base URL is `https://api.telegram.org`. The token is never logged and never put in a URL that gets written to console output.
- Commit after every task. Use `npm test` as the gate.

---

### Task 1: Telegram sender

**Files:**
- Create: `src/lib/telegram.js`
- Test: `test/telegram.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `sendMessage({ token, chatId, text }, { fetch }) -> Promise<{ ok: true } | { ok: false, error: string }>`

- [ ] **Step 1: Write the failing test**

Create `test/telegram.test.js`:

```js
import { describe, it, expect, vi } from "vitest";
import { sendMessage } from "../src/lib/telegram.js";

const okFetch = () => vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, result: {} }) }));

describe("sendMessage", () => {
  it("posts the text to the bot's sendMessage endpoint", async () => {
    const fetch = okFetch();
    const res = await sendMessage({ token: "123:ABC", chatId: "555", text: "hello" }, { fetch });
    expect(res).toEqual({ ok: true });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://api.telegram.org/bot123:ABC/sendMessage");
    expect(init.method).toBe("POST");
    expect(init.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual({ chat_id: "555", text: "hello", disable_web_page_preview: false });
  });

  it("reports telegram's own description when the API refuses", async () => {
    const fetch = vi.fn(async () => ({ ok: false, status: 400, json: async () => ({ ok: false, description: "chat not found" }) }));
    expect(await sendMessage({ token: "t", chatId: "c", text: "x" }, { fetch })).toEqual({ ok: false, error: "chat not found" });
  });

  it("reports a body that says ok: false even on HTTP 200", async () => {
    const fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: false, description: "bot was blocked by the user" }) }));
    expect(await sendMessage({ token: "t", chatId: "c", text: "x" }, { fetch })).toEqual({ ok: false, error: "bot was blocked by the user" });
  });

  it("turns a network failure into a result instead of throwing", async () => {
    const fetch = vi.fn(async () => { throw new Error("offline"); });
    expect(await sendMessage({ token: "t", chatId: "c", text: "x" }, { fetch })).toEqual({ ok: false, error: "offline" });
  });

  it("refuses to send without a token or chat id", async () => {
    const fetch = okFetch();
    expect(await sendMessage({ token: "", chatId: "c", text: "x" }, { fetch })).toMatchObject({ ok: false });
    expect(await sendMessage({ token: "t", chatId: "", text: "x" }, { fetch })).toMatchObject({ ok: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("falls back to a status line when telegram sends no description", async () => {
    const fetch = vi.fn(async () => ({ ok: false, status: 502, json: async () => { throw new Error("not json"); } }));
    expect(await sendMessage({ token: "t", chatId: "c", text: "x" }, { fetch })).toEqual({ ok: false, error: "Telegram returned HTTP 502." });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/telegram.test.js`
Expected: FAIL, cannot resolve `../src/lib/telegram.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/telegram.js`:

```js
// Sends one message through a Telegram bot. `fetch` is injected so tests never
// touch the network. Every failure comes back as a value, never as a throw: a
// Telegram outage must not be able to wedge the restock monitor's tick.
const ORIGIN = "https://api.telegram.org";

export async function sendMessage({ token, chatId, text }, { fetch = globalThis.fetch } = {}) {
  if (!token || !chatId) return { ok: false, error: "Telegram is not configured." };
  try {
    const res = await fetch(`${ORIGIN}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: String(chatId), text: String(text), disable_web_page_preview: false }),
    });
    let body = null;
    try { body = await res.json(); } catch { /* telegram sent something that is not JSON */ }
    if (body?.ok === true) return { ok: true };
    if (body?.description) return { ok: false, error: String(body.description) };
    return { ok: false, error: `Telegram returned HTTP ${res.status}.` };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
}
```

- [ ] **Step 4: Run the whole suite**

Run: `npm test`
Expected: PASS, 252 existing plus 6 new.

- [ ] **Step 5: Commit**

```bash
git add src/lib/telegram.js test/telegram.test.js
git commit -m "feat: telegram sender for restock alerts"
```

---

### Task 2: Watch scheduling and transition rules

**Files:**
- Create: `src/lib/watch-entry.js`
- Test: `test/watch-entry.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `DEFAULT_INTERVAL_MINUTES = 5`, `MAX_BACKOFF_MINUTES = 60`, `MAX_CHECKS_PER_TICK = 3`, `ERROR_ALERT_AFTER = 3`
  - `watchId(retailer, itemId) -> string`
  - `createWatch({ retailer, itemId, input, postalCode, intervalMinutes, now }) -> Watch`
  - `backoffMinutes(intervalMinutes, failures) -> number`
  - `nextCheckAt({ now, intervalMinutes, failures, random }) -> number`
  - `dueWatches(watches, now, limit) -> Watch[]`
  - `applyResult(watch, result, { now, random }) -> { watch, alert }` where `alert` is `"restock" | "error" | "recovery" | null`
  - `confirmAlert(watch, alert) -> Watch`

- [ ] **Step 1: Write the failing test**

Create `test/watch-entry.test.js`:

```js
import { describe, it, expect } from "vitest";
import {
  DEFAULT_INTERVAL_MINUTES, MAX_BACKOFF_MINUTES, MAX_CHECKS_PER_TICK, ERROR_ALERT_AFTER,
  watchId, createWatch, backoffMinutes, nextCheckAt, dueWatches, applyResult, confirmAlert,
} from "../src/lib/watch-entry.js";

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
      .toBe("Delivery to M5V 3L9: In stock · arrives Sep 21 · Ships from DealWiz");
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

  it("alerts exactly once, on the third consecutive failure", () => {
    expect(applyResult(base({ failures: 1 }), err, { now: NOW, random: () => 0.5 }).alert).toBeNull();
    expect(applyResult(base({ failures: ERROR_ALERT_AFTER - 1 }), err, { now: NOW, random: () => 0.5 }).alert).toBe("error");
    expect(applyResult(base({ failures: 9, alertedError: true }), err, { now: NOW, random: () => 0.5 }).alert).toBeNull();
  });

  it("says checks are working again after an error streak, and only then", () => {
    const recovered = applyResult(base({ failures: 5, alertedError: true }), okResult("out_of_stock"), { now: NOW, random: () => 0.5 });
    expect(recovered.alert).toBe("recovery");
    expect(recovered.watch.failures).toBe(0);
    expect(recovered.watch.alertedError).toBe(false);
    expect(applyResult(base(), okResult("out_of_stock"), { now: NOW, random: () => 0.5 }).alert).toBeNull();
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
  it("leaves the entry alone for a recovery note or no alert", () => {
    const w = base({ status: "out_of_stock", notifiedStatus: "out_of_stock" });
    expect(confirmAlert(w, "recovery")).toEqual(w);
    expect(confirmAlert(w, null)).toEqual(w);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/watch-entry.test.js`
Expected: FAIL, cannot resolve `../src/lib/watch-entry.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/watch-entry.js`:

```js
// Pure rules for one watchlist entry: when it is next due, and what a check result
// means. No storage, no network, no clock — the runner in watch.js supplies those.
//
// Two statuses are kept on purpose. `status` is what the retailer last said.
// `notifiedStatus` is what the user has been told. A restock message only moves
// `notifiedStatus` once Telegram has accepted it (see confirmAlert), so a failed
// send is retried on the next tick instead of being swallowed.
import { deliveryText } from "./delivery.js";

export const DEFAULT_INTERVAL_MINUTES = 5;
export const MAX_BACKOFF_MINUTES = 60;
export const MAX_CHECKS_PER_TICK = 3;
export const ERROR_ALERT_AFTER = 3;

const MIN = 60_000;
const JITTER_MIN = 0.75;
const JITTER_MAX = 1.25;

export function watchId(retailer, itemId) {
  return `${retailer}:${itemId}`;
}

export function createWatch({ retailer, itemId, input, postalCode, intervalMinutes = DEFAULT_INTERVAL_MINUTES, now }) {
  return {
    id: watchId(retailer, itemId),
    retailer, itemId, input, postalCode, intervalMinutes,
    name: null, url: null, priceString: null,
    status: null, notifiedStatus: null, deliveryText: null,
    lastCheckedAt: null, nextCheckAt: now,
    failures: 0, lastError: null, alertedError: false,
    notifiedAt: null, paused: false, createdAt: now,
  };
}

export function backoffMinutes(intervalMinutes, failures) {
  return Math.min(intervalMinutes * 2 ** failures, MAX_BACKOFF_MINUTES);
}

export function nextCheckAt({ now, intervalMinutes, failures, random }) {
  const jitter = JITTER_MIN + random() * (JITTER_MAX - JITTER_MIN);
  return now + backoffMinutes(intervalMinutes, failures) * MIN * jitter;
}

export function dueWatches(watches, now, limit = MAX_CHECKS_PER_TICK) {
  return watches
    .filter((w) => !w.paused && w.nextCheckAt <= now)
    .sort((a, b) => a.nextCheckAt - b.nextCheckAt)
    .slice(0, limit);
}

// result is a content-script response: { ok: true, item } or { ok: false, code, error }.
export function applyResult(watch, result, { now, random }) {
  if (!result?.ok) {
    const failures = watch.failures + 1;
    const shouldAlert = failures >= ERROR_ALERT_AFTER && !watch.alertedError;
    return {
      watch: {
        ...watch,
        failures,
        lastError: { code: result?.code ?? "unknown", message: result?.error ?? "The check failed." },
        lastCheckedAt: now,
        nextCheckAt: nextCheckAt({ now, intervalMinutes: watch.intervalMinutes, failures, random }),
      },
      alert: shouldAlert ? "error" : null,
    };
  }

  const item = result.item ?? {};
  const status = item.delivery?.status ?? "unknown";
  const restock = status === "available" && watch.notifiedStatus !== "available";
  const next = {
    ...watch,
    name: item.name ?? watch.name,
    url: item.url ?? watch.url,
    priceString: item.priceString ?? watch.priceString,
    status,
    // Only "available" waits for a confirmed send; every other status is silent,
    // so it can follow along immediately and let the next return alert again.
    notifiedStatus: status === "available" ? watch.notifiedStatus : status,
    deliveryText: item.delivery ? deliveryText(item.delivery, watch.postalCode) : null,
    lastCheckedAt: now,
    nextCheckAt: nextCheckAt({ now, intervalMinutes: watch.intervalMinutes, failures: 0, random }),
    failures: 0,
    lastError: null,
    alertedError: false,
  };
  const recovered = watch.alertedError && !restock;
  return { watch: next, alert: restock ? "restock" : recovered ? "recovery" : null };
}

// Applied only after the notifier reported success, which is what makes a failed
// send retry rather than vanish.
export function confirmAlert(watch, alert) {
  if (alert === "restock") return { ...watch, notifiedStatus: "available", notifiedAt: watch.lastCheckedAt };
  if (alert === "error") return { ...watch, alertedError: true };
  return watch;
}
```

- [ ] **Step 4: Run the whole suite**

Run: `npm test`
Expected: PASS. The new file adds 20 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/watch-entry.js test/watch-entry.test.js
git commit -m "feat: watchlist scheduling and status-transition rules"
```

---

### Task 3: Watch runner

**Files:**
- Create: `src/lib/watch.js`
- Test: `test/watch.test.js`

**Interfaces:**
- Consumes: everything Task 2 produces; `deliveryText` from `src/lib/delivery.js`.
- Produces:
  - `WATCHES_KEY = "watches"`, `SETTINGS_KEY = "watchSettings"`, `DEFAULT_SETTINGS`
  - `alertText(alert, watch) -> string`
  - `createWatcher({ forward, storage, getJob, notify, now, random }) -> { tick, list, add, remove, setPaused, setSettings }`
  - `notify(text) -> Promise<{ ok: boolean, error?: string }>` is the injected notifier contract.
  - `tick() -> Promise<{ checked: number, skipped: string | null }>`

- [ ] **Step 1: Write the failing test**

Create `test/watch.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/watch.test.js`
Expected: FAIL, cannot resolve `../src/lib/watch.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/watch.js`:

```js
// The restock monitor's runner. It owns the watchlist in chrome.storage.local and
// is driven by a chrome.alarms tick from background.js.
//
// Everything it touches is injected, the way createJobs is, so the whole thing is
// testable without a browser: `forward` reaches a retailer's content script,
// `getJob` reports the foreground job, `notify` sends one line of text.
import { RETAILERS } from "../retailers/index.js";
import {
  DEFAULT_INTERVAL_MINUTES, MAX_CHECKS_PER_TICK,
  applyResult, confirmAlert, createWatch, dueWatches, watchId,
} from "./watch-entry.js";

export const WATCHES_KEY = "watches";
export const SETTINGS_KEY = "watchSettings";
export const DEFAULT_SETTINGS = { enabled: false, telegram: null, intervalMinutes: DEFAULT_INTERVAL_MINUTES };

const label = (retailer) => RETAILERS[retailer]?.label ?? retailer;

// One line of text per alert. The delivery wording is the retailer's own, kept
// from the check, so the message never promises more than the site did.
export function alertText(alert, watch) {
  const name = watch.name ?? watch.input;
  const head = [label(watch.retailer), watch.priceString].filter(Boolean).join(" · ");
  if (alert === "restock") {
    return [`🟢 In stock — ${name}`, head, watch.deliveryText, watch.url].filter(Boolean).join("\n");
  }
  if (alert === "error") {
    return [`⚠️ Cannot check ${name}`, head, watch.lastError?.message, "Checks will keep retrying, less often."].filter(Boolean).join("\n");
  }
  return [`✅ Checks working again — ${name}`, head].filter(Boolean).join("\n");
}

export function createWatcher({ forward, storage, getJob, notify, now = Date.now, random = Math.random }) {
  async function read() {
    const stored = await storage.get([WATCHES_KEY, SETTINGS_KEY]);
    return {
      watches: stored?.[WATCHES_KEY] ?? [],
      settings: { ...DEFAULT_SETTINGS, ...(stored?.[SETTINGS_KEY] ?? {}) },
    };
  }

  const saveWatches = (watches) => storage.set({ [WATCHES_KEY]: watches });
  const replace = (watches, next) => watches.map((w) => (w.id === next.id ? next : w));

  async function list() {
    return read();
  }

  async function add({ retailer, itemId, input, postalCode }) {
    const { watches, settings } = await read();
    const id = watchId(retailer, itemId);
    const existing = watches.find((w) => w.id === id);
    const next = existing
      ? { ...existing, input, postalCode, paused: false, nextCheckAt: now() }
      : createWatch({ retailer, itemId, input, postalCode, intervalMinutes: settings.intervalMinutes, now: now() });
    await saveWatches(existing ? replace(watches, next) : [...watches, next]);
    return next;
  }

  async function remove(id) {
    const { watches } = await read();
    await saveWatches(watches.filter((w) => w.id !== id));
  }

  async function setPaused(id, paused) {
    const { watches } = await read();
    const found = watches.find((w) => w.id === id);
    if (!found) return null;
    const next = { ...found, paused: Boolean(paused) };
    await saveWatches(replace(watches, next));
    return next;
  }

  async function setSettings(patch) {
    const { settings } = await read();
    const next = { ...settings, ...patch };
    await storage.set({ [SETTINGS_KEY]: next });
    return next;
  }

  // Checks one entry and returns the entry as it should be stored. A send that
  // fails leaves notifiedStatus alone, so the next tick tries the message again.
  async function check(watch) {
    let result;
    try {
      result = await forward({ type: "lookup", retailer: watch.retailer, itemId: watch.itemId, postalCode: watch.postalCode, mode: "delivery" });
    } catch (err) {
      result = { ok: false, code: "unknown", error: String(err?.message ?? err) };
    }
    const { watch: updated, alert } = applyResult(watch, result, { now: now(), random });
    if (!alert) return updated;
    try {
      const sent = await notify(alertText(alert, updated));
      return sent?.ok ? confirmAlert(updated, alert) : updated;
    } catch {
      return updated; // a broken notifier must never cost us the check result
    }
  }

  async function tick() {
    const { watches, settings } = await read();
    if (!settings.enabled) return { checked: 0, skipped: "disabled" };
    if (!settings.telegram?.token || !settings.telegram?.chatId) return { checked: 0, skipped: "unconfigured" };
    const job = await getJob();
    if (job?.phase === "lookup" || job?.phase === "searching") return { checked: 0, skipped: "busy" };

    const due = dueWatches(watches, now(), MAX_CHECKS_PER_TICK);
    if (!due.length) return { checked: 0, skipped: null };

    let current = watches;
    for (const watch of due) {
      current = replace(current, await check(watch));
    }
    await saveWatches(current);
    return { checked: due.length, skipped: null };
  }

  return { tick, list, add, remove, setPaused, setSettings };
}
```

- [ ] **Step 4: Run the whole suite**

Run: `npm test`
Expected: PASS. The new file adds 19 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/watch.js test/watch.test.js
git commit -m "feat: restock watch runner over the delivery lookup"
```

---

### Task 4: Background wiring, alarm and permissions

**Files:**
- Modify: `src/manifest.json`
- Modify: `src/background.js`
- Test: `test/background.test.js`

**Interfaces:**
- Consumes: `createWatcher` from Task 3, `sendMessage` from Task 1.
- Produces:
  - `WATCH_ALARM = "watchTick"`
  - `makeWatcher(chrome, jobs, sleepMs) -> Watcher`
  - Message types handled: `getWatchState`, `addWatch`, `removeWatch`, `pauseWatch`, `setWatchSettings`, `testTelegram`.

- [ ] **Step 1: Write the failing test**

Append to `test/background.test.js`:

```js
import { handle, makeWatcher, WATCH_ALARM } from "../src/background.js";

function fakeWatcher(over = {}) {
  return {
    tick: vi.fn(async () => ({ checked: 0, skipped: null })),
    list: vi.fn(async () => ({ watches: [{ id: "walmart:1" }], settings: { enabled: true, telegram: { token: "t", chatId: "c" }, intervalMinutes: 5 } })),
    add: vi.fn(async (w) => ({ id: `${w.retailer}:${w.itemId}` })),
    remove: vi.fn(async () => {}),
    setPaused: vi.fn(async (id, paused) => ({ id, paused })),
    setSettings: vi.fn(async (p) => ({ enabled: true, ...p })),
    ...over,
  };
}

describe("background watch messages", () => {
  it("returns the watchlist and settings", async () => {
    const { chrome } = fakeChrome();
    const watcher = fakeWatcher();
    const res = await handle({ type: "getWatchState" }, { chrome, watcher });
    expect(res.ok).toBe(true);
    expect(res.watches).toHaveLength(1);
    expect(res.settings.enabled).toBe(true);
  });

  it("adds a watch without needing a retailer tab", async () => {
    const { chrome } = fakeChrome();
    const watcher = fakeWatcher();
    const res = await handle({ type: "addWatch", retailer: "walmart", itemId: "1", input: "u", postalCode: "T3A 5S8" }, { chrome, watcher });
    expect(res).toMatchObject({ ok: true, watch: { id: "walmart:1" } });
    expect(watcher.add).toHaveBeenCalledWith({ retailer: "walmart", itemId: "1", input: "u", postalCode: "T3A 5S8" });
  });

  it("rejects a watch for a retailer that is not supported", async () => {
    const { chrome } = fakeChrome();
    const watcher = fakeWatcher();
    expect(await handle({ type: "addWatch", retailer: "sears", itemId: "1" }, { chrome, watcher }))
      .toMatchObject({ ok: false, code: "unsupported" });
    expect(watcher.add).not.toHaveBeenCalled();
  });

  it("removes, pauses and updates settings", async () => {
    const { chrome } = fakeChrome();
    const watcher = fakeWatcher();
    expect(await handle({ type: "removeWatch", id: "walmart:1" }, { chrome, watcher })).toEqual({ ok: true });
    expect(await handle({ type: "pauseWatch", id: "walmart:1", paused: true }, { chrome, watcher })).toMatchObject({ ok: true, watch: { paused: true } });
    expect(await handle({ type: "setWatchSettings", settings: { intervalMinutes: 9 } }, { chrome, watcher })).toMatchObject({ ok: true, settings: { intervalMinutes: 9 } });
  });

  it("sends a real test message through the configured bot", async () => {
    const { chrome } = fakeChrome();
    const watcher = fakeWatcher();
    const fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }));
    const res = await handle({ type: "testTelegram" }, { chrome, watcher, fetch });
    expect(res).toEqual({ ok: true });
    expect(fetch.mock.calls[0][0]).toBe("https://api.telegram.org/bott/sendMessage");
  });

  it("says so when a test message is asked for before telegram is configured", async () => {
    const { chrome } = fakeChrome();
    const watcher = fakeWatcher({ list: vi.fn(async () => ({ watches: [], settings: { enabled: false, telegram: null, intervalMinutes: 5 } })) });
    expect(await handle({ type: "testTelegram" }, { chrome, watcher })).toMatchObject({ ok: false });
  });
});

describe("makeWatcher", () => {
  it("asks the retailer's content script and reads the foreground job", async () => {
    const { chrome } = fakeChrome({ tabs: [{ id: 1, url: "https://www.walmart.ca/en" }] });
    chrome.storage = {
      local: (() => { let d = {}; return { get: async (k) => Object.fromEntries((Array.isArray(k) ? k : [k]).filter((x) => x in d).map((x) => [x, d[x]])), set: async (p) => { d = { ...d, ...p }; } }; })(),
    };
    const jobs = { get: async () => null };
    const watcher = makeWatcher(chrome, jobs, 0, async () => ({ ok: true }));
    await watcher.setSettings({ enabled: true, telegram: { token: "t", chatId: "c" } });
    await watcher.add({ retailer: "walmart", itemId: "1", input: "u", postalCode: "T3A 5S8" });
    await watcher.tick();
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(1, expect.objectContaining({ type: "lookup", mode: "delivery" }));
  });
});

describe("watch alarm", () => {
  it("names the alarm the worker listens for", () => {
    expect(WATCH_ALARM).toBe("watchTick");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/background.test.js`
Expected: FAIL, `makeWatcher` and `WATCH_ALARM` are not exported.

- [ ] **Step 3: Update the manifest**

In `src/manifest.json`, change the `permissions` line and the `host_permissions` line, and add an options page:

```json
  "permissions": ["storage", "tabs", "alarms"],
  "host_permissions": ["https://www.walmart.ca/*", "https://www.bestbuy.ca/*", "https://www.staples.ca/*", "https://api.staples.ca/*", "https://www.shoppersdrugmart.ca/*", "https://api.shoppersdrugmart.ca/*", "https://api.telegram.org/*"],
  "options_ui": { "page": "options/options.html", "open_in_tab": true },
```

- [ ] **Step 4: Write the implementation**

In `src/background.js`, add to the imports:

```js
import { createWatcher, DEFAULT_SETTINGS } from "./lib/watch.js";
import { sendMessage } from "./lib/telegram.js";
```

Add below `makeJobs`:

```js
export const WATCH_ALARM = "watchTick";

// The restock monitor. `send` is injected so tests never reach Telegram.
export function makeWatcher(chrome, jobs, sleepMs, send = sendMessage) {
  const storage = chrome.storage?.local;
  return createWatcher({
    forward: (msg) => forward(chrome, RETAILERS[msg.retailer], msg, sleepMs, FORWARD_ATTEMPTS),
    storage,
    getJob: () => jobs.get(),
    notify: async (text) => {
      const stored = await storage.get(["watchSettings"]);
      const telegram = { ...DEFAULT_SETTINGS, ...(stored?.watchSettings ?? {}) }.telegram;
      return send({ ...telegram, text });
    },
  });
}
```

Inside `handle()`, add these cases to the first `switch` (the one that runs before the retailer lookup, because none of them needs a retailer tab except `addWatch`, which validates its own):

```js
    case "getWatchState": {
      const { watches, settings } = await watcher.list();
      return { ok: true, watches, settings };
    }
    case "removeWatch":
      await watcher.remove(msg.id);
      return { ok: true };
    case "pauseWatch":
      return { ok: true, watch: await watcher.setPaused(msg.id, msg.paused) };
    case "setWatchSettings":
      return { ok: true, settings: await watcher.setSettings(msg.settings ?? {}) };
    case "testTelegram": {
      const { settings } = await watcher.list();
      if (!settings.telegram?.token || !settings.telegram?.chatId) {
        return { ok: false, code: "unknown", error: "Enter a bot token and a chat id first." };
      }
      return send({ ...settings.telegram, text: "Pickup Finder is connected. You will hear from this bot when something comes back in stock." }, { fetch });
    }
```

Change the signature of `handle` so the watcher, the sender and fetch can be injected:

```js
export async function handle(msg, { chrome = globalThis.chrome, sleepMs, jobs, watcher, send = sendMessage, fetch = globalThis.fetch } = {}) {
```

Add `addWatch` to the second `switch`, the one that runs after the retailer has been validated, so an unsupported retailer is refused before anything is stored:

```js
    case "addWatch":
      return { ok: true, watch: await watcher.add({ retailer: msg.retailer, itemId: msg.itemId, input: msg.input, postalCode: msg.postalCode }) };
```

At the bottom, where the worker wires itself up, create the alarm and route it:

```js
if (globalThis.chrome?.runtime?.onMessage) {
  const jobs = makeJobs(chrome);
  const watcher = makeWatcher(chrome, jobs);
  jobs.recover();
  // create() with an existing name replaces it, so this is safe on every worker start.
  chrome.alarms.create(WATCH_ALARM, { periodInMinutes: 1 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === WATCH_ALARM) watcher.tick().catch(() => {});
  });
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (sender.tab && msg?.type === "searchProgress") { jobs.progress(msg); return false; }
    if (!sender.url?.startsWith(chrome.runtime.getURL("/"))) return false;
    handle(msg, { jobs, watcher }).then(sendResponse, (err) => sendResponse({ ok: false, code: "unknown", error: String(err?.message ?? err) }));
    return true;
  });
}
```

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: PASS. The background file gains 8 tests.

- [ ] **Step 6: Commit**

```bash
git add src/background.js src/manifest.json test/background.test.js
git commit -m "feat: alarm-driven watch tick and watchlist messages"
```

---

### Task 5: Options page

**Files:**
- Create: `src/options/options.html`
- Create: `src/options/options.css`
- Create: `src/options/options.js`
- Modify: `build.mjs`

**Interfaces:**
- Consumes: the background message types from Task 4.
- Produces: a page reachable from `chrome://extensions`, and `dist/options/options.html` in the build output.

- [ ] **Step 1: Create the page markup**

Create `src/options/options.html`:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Pickup Finder — Restock monitor</title>
  <link rel="stylesheet" href="options.css">
</head>
<body>
  <h1>Restock monitor</h1>

  <section>
    <h2>Telegram</h2>
    <p class="note">The monitor sends restock alerts through a Telegram bot. Create one with
      <a href="https://t.me/BotFather" target="_blank" rel="noopener">BotFather</a>, then message your
      bot once so it is allowed to reply to you.</p>
    <label>Bot token <input id="token" type="password" placeholder="123456:ABC-DEF..." autocomplete="off"></label>
    <label>Chat id <input id="chatId" type="text" placeholder="123456789" autocomplete="off"></label>
    <p class="note">The token is stored in this extension's storage. Other extensions cannot read it,
      but anyone with access to this Chrome profile on disk can.</p>
    <button id="test" type="button" class="secondary">Send test message</button>
    <p id="testResult" class="note" hidden></p>
  </section>

  <section>
    <h2>Checking</h2>
    <label class="row"><input id="enabled" type="checkbox"> Monitor is running</label>
    <label>Minutes between checks for each item
      <input id="interval" type="number" min="1" max="60" step="1">
    </label>
    <p id="rate" class="note"></p>
  </section>

  <section>
    <h2>Watchlist</h2>
    <p id="empty" class="note" hidden>Nothing is being watched. Paste a product URL in the popup and press
      "Watch for restock".</p>
    <ol id="watches" class="watches"></ol>
  </section>

  <template id="watchRow">
    <li class="watch">
      <div class="watch-main">
        <a class="watch-name" target="_blank" rel="noopener"></a>
        <div class="watch-meta"></div>
        <div class="watch-error" hidden></div>
      </div>
      <div class="watch-side">
        <span class="badge"></span>
        <button class="pause secondary" type="button">Pause</button>
        <button class="remove secondary" type="button">Remove</button>
      </div>
    </li>
  </template>

  <script src="options.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create the stylesheet**

Create `src/options/options.css`:

```css
:root { color-scheme: light dark; }
body { font: 14px/1.5 system-ui, sans-serif; margin: 0 auto; max-width: 42rem; padding: 1.5rem; }
h1 { font-size: 1.3rem; }
h2 { font-size: 1rem; margin-bottom: .4rem; }
section { border-top: 1px solid rgba(128,128,128,.35); margin-top: 1.25rem; padding-top: 1rem; }
label { display: block; margin: .5rem 0; }
label.row { align-items: center; display: flex; gap: .5rem; }
input[type="text"], input[type="password"], input[type="number"] { display: block; margin-top: .25rem; padding: .35rem; width: 100%; }
input[type="number"] { width: 6rem; }
button { cursor: pointer; padding: .4rem .8rem; }
button.secondary { background: none; border: 1px solid rgba(128,128,128,.6); border-radius: .25rem; }
.note { color: rgba(128,128,128,1); font-size: .85rem; }
.watches { list-style: none; margin: 0; padding: 0; }
.watch { border-top: 1px solid rgba(128,128,128,.25); display: flex; gap: 1rem; justify-content: space-between; padding: .6rem 0; }
.watch-side { align-items: center; display: flex; gap: .4rem; }
.watch-meta, .watch-error { color: rgba(128,128,128,1); font-size: .85rem; }
.watch-error { color: #b3261e; }
.badge { border-radius: .25rem; font-size: .8rem; padding: .1rem .4rem; }
.badge.available { background: #1b5e20; color: #fff; }
.badge.out_of_stock { background: rgba(128,128,128,.3); }
.badge.unknown, .badge.never { background: rgba(128,128,128,.15); }
```

- [ ] **Step 3: Create the page script**

Create `src/options/options.js`:

```js
// The restock monitor's settings and watchlist. Every change goes through the
// background worker, which owns the storage, so two open copies of this page
// cannot write over each other.
const $ = (id) => document.getElementById(id);
const STATUS_LABEL = { available: "In stock", out_of_stock: "Out of stock", unknown: "Unknown" };

const send = (msg) => chrome.runtime.sendMessage(msg);

function when(ts) {
  if (!ts) return "never";
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins <= 0) return "just now";
  if (mins < 60) return `${mins} min ago`;
  return `${Math.round(mins / 60)} h ago`;
}

function rateNote(watches, intervalMinutes) {
  const active = watches.filter((w) => !w.paused).length;
  if (!active) return "Nothing is being checked.";
  const per5 = ((active * 5) / intervalMinutes).toFixed(1);
  return `About ${per5} checks every 5 minutes. Walmart starts refusing at roughly 25, so keep some room for your own searches.`;
}

function watchRow(w) {
  const li = $("watchRow").content.firstElementChild.cloneNode(true);
  const name = li.querySelector(".watch-name");
  name.textContent = w.name ?? w.input;
  if (w.url) name.href = w.url;
  li.querySelector(".watch-meta").textContent =
    [w.retailer, w.priceString, `to ${w.postalCode}`, `checked ${when(w.lastCheckedAt)}`].filter(Boolean).join(" · ");
  const error = li.querySelector(".watch-error");
  if (w.lastError) {
    error.textContent = `${w.lastError.message} (${w.failures} in a row)`;
    error.hidden = false;
  }
  const badge = li.querySelector(".badge");
  badge.textContent = w.paused ? "Paused" : (STATUS_LABEL[w.status] ?? "Not checked yet");
  badge.classList.add(w.status ?? "never");
  const pause = li.querySelector(".pause");
  pause.textContent = w.paused ? "Resume" : "Pause";
  pause.addEventListener("click", async () => { await send({ type: "pauseWatch", id: w.id, paused: !w.paused }); load(); });
  li.querySelector(".remove").addEventListener("click", async () => { await send({ type: "removeWatch", id: w.id }); load(); });
  return li;
}

function render({ watches, settings }) {
  $("token").value = settings.telegram?.token ?? "";
  $("chatId").value = settings.telegram?.chatId ?? "";
  $("enabled").checked = Boolean(settings.enabled);
  $("interval").value = settings.intervalMinutes;
  $("rate").textContent = rateNote(watches, settings.intervalMinutes);
  $("empty").hidden = watches.length > 0;
  $("watches").replaceChildren(...watches.map(watchRow));
}

async function load() {
  const res = await send({ type: "getWatchState" });
  if (res?.ok) render(res);
}

async function saveSettings() {
  const token = $("token").value.trim();
  const chatId = $("chatId").value.trim();
  const intervalMinutes = Math.min(60, Math.max(1, Number($("interval").value) || 5));
  await send({
    type: "setWatchSettings",
    settings: { enabled: $("enabled").checked, intervalMinutes, telegram: token && chatId ? { token, chatId } : null },
  });
  load();
}

for (const id of ["token", "chatId", "interval"]) $(id).addEventListener("change", saveSettings);
$("enabled").addEventListener("change", saveSettings);

$("test").addEventListener("click", async () => {
  await saveSettings();
  $("test").disabled = true;
  const res = await send({ type: "testTelegram" });
  $("testResult").textContent = res?.ok ? "Sent. Check Telegram." : `Failed: ${res?.error ?? "unknown error"}`;
  $("testResult").hidden = false;
  $("test").disabled = false;
});

load();
```

- [ ] **Step 4: Add the page to the build**

In `build.mjs`, add the options entry point and copy its assets. Change the `mkdirSync` line, the `entryPoints` object and the copy block:

```js
mkdirSync("dist/popup", { recursive: true });
mkdirSync("dist/options", { recursive: true });
```

```js
    "background": "src/background.js",
    "popup/popup": "src/popup/popup.js",
    "options/options": "src/options/options.js",
```

```js
cpSync("src/popup/popup.css", "dist/popup/popup.css");
cpSync("src/options/options.html", "dist/options/options.html");
cpSync("src/options/options.css", "dist/options/options.css");
```

- [ ] **Step 5: Verify the build produces the page**

Run: `npm run build && ls dist/options`
Expected: `options.css`, `options.html`, `options.js`.

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: PASS, unchanged count. This task adds no tests; the page is exercised end to end in Task 7.

- [ ] **Step 7: Commit**

```bash
git add src/options build.mjs
git commit -m "feat: options page for the restock monitor"
```

---

### Task 6: Watch button in the popup

**Files:**
- Modify: `src/popup/popup.html:22`
- Modify: `src/popup/popup.js`
- Modify: `src/popup/popup.css`

**Interfaces:**
- Consumes: `addWatch` from Task 4; `parseProductUrl` and `normalizePostalCode`, already imported by the popup.
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Add the button to the markup**

In `src/popup/popup.html`, replace the submit button line with a row of two buttons and a link to the options page:

```html
    <div class="actions">
      <button id="submit" type="submit">Find stock</button>
      <button id="watch" type="button" class="secondary">Watch for restock</button>
    </div>
  </form>

  <p id="watchNote" class="note" hidden></p>
  <p class="note"><a id="openOptions" href="#">Restock monitor settings</a></p>
```

- [ ] **Step 2: Style the row**

Append to `src/popup/popup.css`:

```css
.actions { display: flex; gap: .5rem; }
.actions button { flex: 1; }
```

- [ ] **Step 3: Wire the button**

In `src/popup/popup.js`, add below the `searchMore` listener:

```js
// "Watch for restock" reuses whatever is already typed: the same parse the search
// uses, and the same postal code. The monitor always asks the delivery question,
// so the mode radio does not apply here.
$("watch").addEventListener("click", async () => {
  const input = $("item").value;
  const parsed = parseProductUrl(input);
  if (!parsed) { showError(`Paste a product URL from ${storesList()} (or a Walmart item ID).`); return; }
  const postalCode = normalizePostalCode($("postal").value);
  if (!postalCode) { showError("Enter a valid Canadian postal code (e.g. M5V 3L9)."); return; }
  $("postal").value = postalCode;
  showError("");
  const res = await chrome.runtime.sendMessage({
    type: "addWatch", retailer: parsed.retailer, itemId: parsed.itemId, input: input.trim(), postalCode,
  });
  const note = $("watchNote");
  note.textContent = res?.ok
    ? `Watching for delivery to ${postalCode}. Alerts go to Telegram; set it up in the extension's options.`
    : `Could not watch this: ${res?.error ?? "unknown error"}`;
  note.hidden = false;
});

$("openOptions").addEventListener("click", (ev) => { ev.preventDefault(); chrome.runtime.openOptionsPage(); });
```

- [ ] **Step 4: Verify the popup still builds and the suite passes**

Run: `npm run build && npm test`
Expected: build writes `dist/`, all tests pass with the count unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/popup
git commit -m "feat: watch for restock button in the popup"
```

---

### Task 7: End-to-end check and documentation

**Files:**
- Modify: `tools/e2e-popup.mjs`
- Modify: `README.md`

**Interfaces:**
- Consumes: everything above.
- Produces: a runnable end-to-end scenario, and user-facing docs.

- [ ] **Step 1: Add a watch scenario to the end-to-end tool**

In `tools/e2e-popup.mjs`, after the existing scenarios finish, add a block that drives the options page and one tick. Insert before `finish(0)`:

```js
// Restock monitor: configure a stub bot, add a watch, force it due, run one tick,
// and read back what the monitor recorded. No real Telegram message is sent: the
// options page is given a token that api.telegram.org will reject, and the check
// asserts on the stored status rather than on delivery.
if (process.env.WATCH) {
  const [url, postal] = process.env.WATCH.split("|");
  const parsedId = url.split("/").pop();
  console.log(`\n=== watch ${url} @ ${postal}`);
  await openPopup();
  await evalIn(`document.getElementById("item").value = ${JSON.stringify(url)};
    document.getElementById("postal").value = ${JSON.stringify(postal)};
    document.getElementById("watch").click();`);
  await sleep(1500);
  const state = await evalIn(`(async () => {
    await chrome.runtime.sendMessage({ type: "setWatchSettings", settings: { enabled: true, telegram: { token: "0:stub", chatId: "0" }, intervalMinutes: 5 } });
    const before = await chrome.runtime.sendMessage({ type: "getWatchState" });
    const id = before.watches[0].id;
    await new Promise((r) => setTimeout(r, 12000)); // let the one-minute alarm fire
    const after = await chrome.runtime.sendMessage({ type: "getWatchState" });
    return JSON.stringify({ id, watch: after.watches.find((w) => w.id === id) });
  })()`);
  console.log(state);
}
```

- [ ] **Step 2: Run it against the real site**

Run:

```sh
npm run build
WATCH="https://www.walmart.ca/en/ip/PlayStation-5-Pro-Console/1SZQHN3LOSE0|T3A 5S8" node tools/e2e-popup.mjs
```

Expected: the printed watch has `status` equal to what a plain delivery lookup returns for the same product, `lastCheckedAt` set, and `notifiedStatus` still null if the item is out of stock. If the item happens to be in stock, `status` is `available` and `notifiedStatus` is null, because the stub token makes the send fail, which is the retry behaviour Task 3 tests.

- [ ] **Step 3: Document the feature**

In `README.md`, add a section after the existing `## Delivery` section:

```markdown
## Restock monitor

The extension can watch a list of products and send a Telegram message when one
becomes deliverable to your postal code. Paste a product URL and a postal code in
the popup, press **Watch for restock**, then open the extension's options page to
enter a bot token and a chat id and switch the monitor on.

Create the bot with [BotFather](https://t.me/BotFather) and send it one message
first, otherwise it is not allowed to write to you. The **Send test message**
button on the options page reports Telegram's own error if anything is wrong.

Checks run on a one-minute alarm, and each item is re-checked every five minutes
by default. A check makes the same delivery lookup the popup makes, so it costs
one request per item. The monitor stands aside while a search you started by hand
is running, and backs off when a retailer rate-limits it. Three consecutive
failures send one message naming the problem, and a message goes out again when
checks start working; silence therefore means the monitor is running and nothing
has changed.

Chrome must be running for the monitor to work, though the window can be
minimised. Chrome may stretch alarms when the machine is idle or on battery, so
treat the cadence as best-effort rather than exact.
```

- [ ] **Step 4: Run the whole suite one last time**

Run: `npm test && npm run build`
Expected: PASS, and `built dist/`.

- [ ] **Step 5: Commit**

```bash
git add tools/e2e-popup.mjs README.md
git commit -m "docs: restock monitor usage and an end-to-end watch scenario"
```

---

## Self-review notes

Spec coverage was checked section by section. Every item is claimed by a task:
the Telegram sender by Task 1, the scheduling and notification rules by Task 2,
the runner, storage keys and message text by Task 3, the alarm, permissions and
message types by Task 4, the options page by Task 5, the popup button by Task 6,
and the end-to-end scenario plus documentation by Task 7.

Two names are worth repeating because later tasks depend on them exactly:
`notifiedStatus` is the field that only moves after a confirmed send, and
`alertText(alert, watch)` builds every message. `notify` takes one string and
returns `{ ok }`; it never receives the settings, because the background worker
binds the token when it constructs the watcher.
