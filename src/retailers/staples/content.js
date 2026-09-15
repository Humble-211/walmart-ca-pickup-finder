// Runs on https://www.staples.ca/*. Answers messages from the background worker.
import * as api from "./api.js";
import { searchInStock } from "./search.js";
import { skuFromHandle } from "./urls.js";
import catalog from "./stores-ca.json";
import { toErrorResponse, WalmartApiError } from "../../lib/errors.js";

function reportProgress(progress) {
  chrome.runtime.sendMessage({ type: "searchProgress", ...progress }).catch(() => {});
}

function skuOf(handle) {
  const sku = skuFromHandle(handle);
  if (!sku) throw new WalmartApiError("not_found");
  return sku;
}

async function handle(msg) {
  switch (msg?.type) {
    case "ping":
      return { ok: true };
    case "lookup": {
      const sku = skuOf(msg.itemId);
      const [item, stores] = await Promise.all([api.getItem(msg.itemId), api.getAvailability(sku, msg.postalCode)]);
      return { ok: true, item, stores: stores.map((s) => ({ ...s, url: item.url })) };
    }
    case "findInStock": {
      if (!Array.isArray(msg.nearby)) return { ok: false, code: "unknown", error: "findInStock needs the nearby store list." };
      const result = await searchInStock({
        sku: skuOf(msg.itemId), nearby: msg.nearby, checkedIds: msg.checkedIds ?? [], onProgress: reportProgress,
        api, catalog: catalog.stores, productUrl: msg.itemUrl ?? `https://www.staples.ca/products/${msg.itemId}`,
      });
      return { ok: true, ...result };
    }
    case "selectStore":
      return { ok: false, code: "unsupported", error: "Staples does not support selecting a store from here; open the product page instead." };
    default:
      return { ok: false, code: "unknown", error: `Unknown message type: ${msg?.type}` };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handle(msg).then(sendResponse, (err) => sendResponse(toErrorResponse(err)));
  return true;
});
