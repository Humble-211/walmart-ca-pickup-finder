// Owns the current lookup-and-search job (src/lib/job.js) and routes its messages to the
// content script of the retailer named in the message. The popup only starts/continues
// jobs and renders the stored job state, so closing it does not stop the work.
import { ERROR_MESSAGES } from "./lib/errors.js";
import { createJobs } from "./lib/job.js";
import { createWatcher, DEFAULT_SETTINGS, SETTINGS_KEY } from "./lib/watch.js";
import { sendMessage } from "./lib/telegram.js";
import { RETAILERS } from "./retailers/index.js";

const READY_TIMEOUT_MS = 15000;
const READY_POLL_MS = 500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ping(chrome, tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: "ping" });
    return res?.ok === true;
  } catch {
    return false;
  }
}

// Returns a tab id on the adapter's host whose content script answers ping, opening one if needed.
async function getTab(chrome, adapter, sleepMs) {
  const tabs = await chrome.tabs.query({ url: `https://${adapter.host}/*` });
  for (const t of tabs) if (await ping(chrome, t.id)) return t.id;
  // A tab opened before the extension was installed/reloaded has no content script until reloaded.
  let target = tabs[0];
  if (target) await chrome.tabs.reload(target.id);
  else target = await chrome.tabs.create({ url: adapter.homeUrl, active: false });
  const deadline = Date.now() + (sleepMs === 0 ? 0 : READY_TIMEOUT_MS);
  do {
    if (await ping(chrome, target.id)) return target.id;
    await sleep(sleepMs ?? READY_POLL_MS);
  } while (Date.now() < deadline);
  return null;
}

// A content script can vanish while it is answering: some sites reload a freshly opened
// tab on their own (shoppersdrugmart.ca does so ~15 s after first load). A failed send is
// therefore retried against a freshly located, ping-verified tab. Callers must not retry
// messages with side effects (selectStore changes the walmart session).
const FORWARD_ATTEMPTS = 3;

async function forward(chrome, adapter, msg, sleepMs, attempts = 1) {
  for (let attempt = 1; ; attempt++) {
    const tabId = await getTab(chrome, adapter, sleepMs);
    if (tabId == null) return { ok: false, code: "no_tab", error: ERROR_MESSAGES.no_tab };
    try {
      return await chrome.tabs.sendMessage(tabId, msg);
    } catch {
      if (attempt >= attempts) return { ok: false, code: "no_tab", error: ERROR_MESSAGES.no_tab };
    }
  }
}

// One job runner per worker. chrome.storage.session lives as long as the browser session and
// is only readable by extension pages, which is exactly the popup's need.
export function makeJobs(chrome, sleepMs) {
  return createJobs({
    forward: (msg) => forward(chrome, RETAILERS[msg.retailer], msg, sleepMs, FORWARD_ATTEMPTS),
    storage: chrome.storage?.session ?? chrome.storage.local,
  });
}

export const WATCH_ALARM = "watchTick";

// The restock monitor. `send` is injected so tests never reach Telegram.
export function makeWatcher(chrome, jobs, sleepMs, send = sendMessage) {
  const storage = chrome.storage?.local;
  return createWatcher({
    forward: (msg) => forward(chrome, RETAILERS[msg.retailer], msg, sleepMs, FORWARD_ATTEMPTS),
    storage,
    getJob: () => jobs.get(),
    notify: async (text) => {
      const stored = await storage.get([SETTINGS_KEY]);
      const telegram = { ...DEFAULT_SETTINGS, ...(stored?.[SETTINGS_KEY] ?? {}) }.telegram;
      return send({ ...telegram, text });
    },
  });
}

// deps: { chrome, sleepMs, jobs, watcher, send, fetch } — injected so tests can run without a service worker.
export async function handle(msg, { chrome = globalThis.chrome, sleepMs, jobs, watcher, send = sendMessage, fetch = globalThis.fetch } = {}) {
  switch (msg?.type) {
    case "getJob":
      return { ok: true, job: await jobs.get() };
    case "continueJob":
      return { ok: true, job: await jobs.continueSearch() };
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
  }
  const adapter = RETAILERS[msg?.retailer];
  if (!adapter) return { ok: false, code: "unsupported", error: ERROR_MESSAGES.unsupported };
  switch (msg?.type) {
    case "startJob":
      return { ok: true, job: await jobs.start({ retailer: msg.retailer, itemId: msg.itemId, postalCode: msg.postalCode, mode: msg.mode, input: msg.input }) };
    case "lookup":
    case "findInStock":
      return forward(chrome, adapter, msg, sleepMs, FORWARD_ATTEMPTS);
    case "selectStore": {
      // Validate before forwarding: a refused URL must never reach the content script,
      // which may change store selection for the whole retailer session (e.g. walmart's setPickup).
      if (typeof msg.itemUrl !== "string" || !msg.itemUrl.startsWith(`https://${adapter.host}/`)) {
        return { ok: false, code: "unknown", error: `Refused to open a URL outside ${adapter.host}.` };
      }
      const res = await forward(chrome, adapter, msg, sleepMs);
      await chrome.tabs.create({ url: msg.itemUrl, active: true });
      return res;
    }
    case "addWatch":
      return { ok: true, watch: await watcher.add({ retailer: msg.retailer, itemId: msg.itemId, input: msg.input, postalCode: msg.postalCode }) };
    default:
      return { ok: false, code: "unknown", error: `Unknown message type: ${msg?.type}` };
  }
}

if (globalThis.chrome?.runtime?.onMessage) {
  const jobs = makeJobs(chrome);
  const watcher = makeWatcher(chrome, jobs);
  jobs.recover(); // a worker restart means any job left mid-flight cannot finish
  // create() with an existing name replaces it, so this is safe on every worker start.
  chrome.alarms.create(WATCH_ALARM, { periodInMinutes: 1 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === WATCH_ALARM) watcher.tick().catch(() => {});
  });
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (sender.tab && msg?.type === "searchProgress") { jobs.progress(msg); return false; } // from a content script
    if (!sender.url?.startsWith(chrome.runtime.getURL("/"))) return false; // otherwise only extension pages (the popup) talk to the background
    handle(msg, { jobs, watcher }).then(sendResponse, (err) => sendResponse({ ok: false, code: "unknown", error: String(err?.message ?? err) }));
    return true;
  });
}
