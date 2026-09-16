// Owns the current lookup-and-search job (src/lib/job.js) and routes its messages to the
// content script of the retailer named in the message. The popup only starts/continues
// jobs and renders the stored job state, so closing it does not stop the work.
import { ERROR_MESSAGES } from "./lib/errors.js";
import { createJobs } from "./lib/job.js";
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

// deps: { chrome, sleepMs, jobs } — injected so tests can run without a service worker.
export async function handle(msg, { chrome = globalThis.chrome, sleepMs, jobs } = {}) {
  switch (msg?.type) {
    case "getJob":
      return { ok: true, job: await jobs.get() };
    case "continueJob":
      return { ok: true, job: await jobs.continueSearch() };
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
    default:
      return { ok: false, code: "unknown", error: `Unknown message type: ${msg?.type}` };
  }
}

if (globalThis.chrome?.runtime?.onMessage) {
  const jobs = makeJobs(chrome);
  jobs.recover(); // a worker restart means any job left mid-flight cannot finish
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (sender.tab && msg?.type === "searchProgress") { jobs.progress(msg); return false; } // from a content script
    if (!sender.url?.startsWith(chrome.runtime.getURL("/"))) return false; // otherwise only extension pages (the popup) talk to the background
    handle(msg, { jobs }).then(sendResponse, (err) => sendResponse({ ok: false, code: "unknown", error: String(err?.message ?? err) }));
    return true;
  });
}
