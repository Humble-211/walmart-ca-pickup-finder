// Routes popup messages to the content script of the retailer named in the message.
import { ERROR_MESSAGES } from "./lib/errors.js";
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

// deps: { chrome, sleepMs } — injected so tests can run without a service worker.
export async function handle(msg, { chrome = globalThis.chrome, sleepMs } = {}) {
  const adapter = RETAILERS[msg?.retailer];
  if (!adapter) return { ok: false, code: "unsupported", error: ERROR_MESSAGES.unsupported };
  switch (msg?.type) {
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
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!sender.url?.startsWith(chrome.runtime.getURL("/"))) return false; // only extension pages (the popup) talk to the background
    handle(msg).then(sendResponse, (err) => sendResponse({ ok: false, code: "unknown", error: String(err?.message ?? err) }));
    return true;
  });
}
