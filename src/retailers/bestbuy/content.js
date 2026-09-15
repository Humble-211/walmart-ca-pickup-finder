// Runs on https://www.bestbuy.ca/*. Answers messages from the background worker.
import * as api from "./api.js";
import { findNearestInStock } from "./search.js";
import catalog from "./stores-ca.json";
import { rankStores } from "../../lib/rank-stores.js";
import { toErrorResponse } from "../../lib/errors.js";

const NEARBY = 10;
const SEARCH_GAP_MS = 1000;
const PRODUCT_URL = (sku) => `https://www.bestbuy.ca/en-ca/product/${sku}`;

function reportProgress(progress) {
  chrome.runtime.sendMessage({ type: "searchProgress", ...progress }).catch(() => {});
}

// The nearest stores to the postal code with this sku's pickup status.
async function lookupStores(postalCode, sku) {
  const all = await api.getStores(postalCode);
  const near = rankStores(all).slice(0, NEARBY);
  if (!near.length) return [];
  const { statuses } = await api.getAvailability(sku, near.map((s) => s.id));
  return near.map((s) => ({
    id: s.id, name: s.name, address: s.address, postalCode: s.postalCode, distanceKm: s.distanceKm,
    status: statuses.get(s.id) ?? "unknown", url: PRODUCT_URL(sku),
  }));
}

async function handle(msg) {
  switch (msg?.type) {
    case "ping":
      return { ok: true };
    case "lookup": {
      const [item, stores] = await Promise.all([api.getItem(msg.itemId), lookupStores(msg.postalCode, msg.itemId)]);
      // Use the canonical (slugged) product URL everywhere now that we have it.
      for (const s of stores) s.url = item.url;
      return { ok: true, item, stores };
    }
    case "findInStock": {
      if (!Array.isArray(msg.nearby)) return { ok: false, code: "unknown", error: "findInStock needs the nearby store list." };
      const result = await findNearestInStock({
        sku: msg.itemId, nearby: msg.nearby, checkedIds: msg.checkedIds ?? [],
        onProgress: reportProgress, api, catalog: catalog.stores, gapMs: SEARCH_GAP_MS,
        productUrl: msg.itemUrl,
      });
      return { ok: true, ...result };
    }
    case "selectStore":
      return { ok: false, code: "unsupported", error: "Best Buy does not support selecting a store from here; open the product page instead." };
    default:
      return { ok: false, code: "unknown", error: `Unknown message type: ${msg?.type}` };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handle(msg).then(sendResponse, (err) => sendResponse(toErrorResponse(err)));
  return true;
});
