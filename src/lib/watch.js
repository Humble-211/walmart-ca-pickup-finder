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
