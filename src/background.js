// Routes popup messages to a content script in a walmart.ca tab.
import { ERROR_MESSAGES } from "./lib/errors.js";

const WALMART_URL = "https://www.walmart.ca/en";
const READY_TIMEOUT_MS = 15000;
const READY_POLL_MS = 500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ping(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: "ping" });
    return res?.ok === true;
  } catch {
    return false;
  }
}

// Returns a tab id whose content script answers ping, opening walmart.ca if needed.
async function getWalmartTab() {
  const tabs = await chrome.tabs.query({ url: "https://www.walmart.ca/*" });
  for (const t of tabs) if (await ping(t.id)) return t.id;
  const created = tabs[0] ?? (await chrome.tabs.create({ url: WALMART_URL, active: false }));
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await ping(created.id)) return created.id;
    await sleep(READY_POLL_MS);
  }
  return null;
}

async function forward(msg) {
  const tabId = await getWalmartTab();
  if (tabId == null) return { ok: false, code: "no_tab", error: ERROR_MESSAGES.no_tab };
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch (err) {
    return { ok: false, code: "no_tab", error: ERROR_MESSAGES.no_tab };
  }
}

async function handle(msg) {
  switch (msg?.type) {
    case "lookup":
      return forward(msg);
    case "selectStore": {
      const res = await forward(msg);
      if (msg.itemUrl) await chrome.tabs.create({ url: msg.itemUrl, active: true });
      return res;
    }
    default:
      return { ok: false, code: "unknown", error: `Unknown message type: ${msg?.type}` };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.tab) return false; // only the popup talks to the background
  handle(msg).then(sendResponse, (err) => sendResponse({ ok: false, code: "unknown", error: String(err?.message ?? err) }));
  return true;
});
