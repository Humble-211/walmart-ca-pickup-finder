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
