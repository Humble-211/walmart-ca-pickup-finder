// Runs on https://www.walmart.ca/*. Answers messages from the background worker.
import { getItem, findStores, selectStore } from "./walmart-api.js";
import { rankStores } from "../lib/rank-stores.js";
import { toErrorResponse } from "../lib/errors.js";

const MAX_STORES = 10;

async function handle(msg) {
  switch (msg?.type) {
    case "ping":
      return { ok: true };
    case "lookup": {
      const [item, stores] = await Promise.all([
        getItem(msg.itemId),
        findStores(msg.postalCode, msg.itemId, MAX_STORES),
      ]);
      return { ok: true, item, stores: rankStores(stores) };
    }
    case "selectStore": {
      const { storeId } = await selectStore(msg.store, msg.postalCode);
      return { ok: true, storeId };
    }
    default:
      return { ok: false, code: "unknown", error: `Unknown message type: ${msg?.type}` };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handle(msg).then(sendResponse, (err) => sendResponse(toErrorResponse(err)));
  return true; // keep the channel open for the async response
});
