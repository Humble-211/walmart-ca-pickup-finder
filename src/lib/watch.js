// The restock monitor's runner. It owns the watchlist in chrome.storage.local and
// is driven by a chrome.alarms tick from background.js.
//
// Everything it touches is injected, the way createJobs is, so the whole thing is
// testable without a browser: `forward` reaches a retailer's content script,
// `getJob` reports the foreground job, `notify` sends one line of text.
import { RETAILERS } from "../retailers/index.js";
import {
  DEFAULT_INTERVAL_MINUTES, MAX_CHECKS_PER_TICK,
  applyResult, backoffMinutes, confirmAlert, createWatch, dueWatches, watchId,
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

// How hard the monitor is leaning on walmart's rate limit, for the options page.
// Only walmart entries count: the limit being described is walmart's, and the other
// three adapters have their own, much looser, budgets. An entry in backoff is counted
// at the interval it is actually using, not the one it would use when healthy.
export function rateNote(watches) {
  const active = (watches ?? []).filter((w) => !w.paused);
  if (!active.length) return "Nothing is being checked.";
  const perMinute = active
    .filter((w) => w.retailer === "walmart")
    .reduce((sum, w) => {
      const base = Number(w.intervalMinutes) > 0 ? Number(w.intervalMinutes) : DEFAULT_INTERVAL_MINUTES;
      return sum + 1 / backoffMinutes(base, w.failures ?? 0);
    }, 0);
  if (!perMinute) return `${active.length} item${active.length === 1 ? "" : "s"} being checked, none of them on Walmart.`;
  return `About ${(perMinute * 5).toFixed(1)} Walmart checks every 5 minutes. Walmart starts refusing at roughly 25 in that window, so keep some room for your own searches.`;
}

export function createWatcher({ forward, storage, getJob, notify, now = Date.now, random = Math.random }) {
  let tickRunning = false;

  async function read() {
    const stored = await storage.get([WATCHES_KEY, SETTINGS_KEY]);
    return {
      watches: stored?.[WATCHES_KEY] ?? [],
      settings: { ...DEFAULT_SETTINGS, ...(stored?.[SETTINGS_KEY] ?? {}) },
    };
  }

  const saveWatches = (watches) => storage.set({ [WATCHES_KEY]: watches });
  const replace = (watches, next) => watches.map((w) => (w.id === next.id ? next : w));

  // Folds a checked entry back into the freshly read list. A check can take the best
  // part of a minute (opening a tab, three forward attempts), and anything the user
  // changed in that window is in the stored list, not in the snapshot the check
  // carried. So the check's own findings win, and the user-owned fields do not.
  const USER_OWNED = ["paused", "postalCode", "input", "intervalMinutes"];
  const foldChecked = (watches, updated) => watches.map((w) => {
    if (w.id !== updated.id) return w;
    const next = { ...updated, ...Object.fromEntries(USER_OWNED.map((k) => [k, w[k]])) };
    // A new postal code asks a different question, so the answer that just came back is
    // about the old destination. Keep the due time add() set (now), so the entry is
    // re-checked against the address the user actually wants instead of in five minutes.
    if (w.postalCode !== updated.postalCode) next.nextCheckAt = w.nextCheckAt;
    return next;
  });

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

  // The options page labels the interval "Minutes between checks for each item", so it
  // has to mean that for the entries already on the list, not only for the next one added.
  async function setSettings(patch) {
    const { watches, settings } = await read();
    const next = { ...settings, ...patch };
    await storage.set({ [SETTINGS_KEY]: next });
    if (next.intervalMinutes !== settings.intervalMinutes && watches.length) {
      await saveWatches(watches.map((w) => ({ ...w, intervalMinutes: next.intervalMinutes })));
    }
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
    if (tickRunning) return { checked: 0, skipped: "running" };
    tickRunning = true;
    try {
      const { watches, settings } = await read();
      if (!settings.enabled) return { checked: 0, skipped: "disabled" };
      if (!settings.telegram?.token || !settings.telegram?.chatId) return { checked: 0, skipped: "unconfigured" };
      const job = await getJob();
      if (job?.phase === "lookup" || job?.phase === "searching") return { checked: 0, skipped: "busy" };

      const due = dueWatches(watches, now(), MAX_CHECKS_PER_TICK);
      if (!due.length) return { checked: 0, skipped: null };

      let checked = [];
      for (const watch of due) {
        checked.push(await check(watch));
      }

      // Merge on write: re-read the stored list and fold checked entries into it
      const { watches: current } = await read();
      let merged = current;
      for (const updated of checked) {
        merged = foldChecked(merged, updated);
      }
      await saveWatches(merged);
      return { checked: checked.length, skipped: null };
    } finally {
      tickRunning = false;
    }
  }

  return { tick, list, add, remove, setPaused, setSettings };
}
