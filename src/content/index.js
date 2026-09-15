// Runs on https://www.walmart.ca/*. Answers messages from the background worker.
import { getItem, findStores, findStoresAround, selectStore } from "./walmart-api.js";
import { rankStores } from "../lib/rank-stores.js";
import { locateUser } from "../lib/geo.js";
import { findNearestInStock } from "../lib/stock-search.js";
import { toErrorResponse } from "../lib/errors.js";
import catalog from "../lib/stores-ca.json";

const MAX_STORES = 10;
// walmart.ca rate-limits at roughly 25 calls per 5 minutes per browser, so one
// nationwide search is capped well below that. The popup can ask to continue.
const SEARCH_MAX_CALLS = 10;
const SEARCH_GAP_MS = 1000;

const coordsById = new Map(catalog.stores.map((s) => [s.id, s]));

function reportProgress(progress) {
  chrome.runtime.sendMessage({ type: "searchProgress", ...progress }).catch(() => {});
}

// Searches beyond the nearby list for the closest stores with stock.
// checkedIds: stores an earlier search already covered (to continue a search).
async function findInStock({ itemId, nearby, checkedIds = [] }) {
  const user = locateUser(nearby, coordsById);
  if (!user) {
    return { inStock: nearby.filter((s) => s.status === "available"), searched: nearby.length, checkedIds: nearby.map((s) => s.id), calls: 0, complete: false, rateLimited: false, noLocation: true };
  }
  const known = new Set(nearby.map((s) => s.id));
  const seed = [...nearby, ...checkedIds.filter((id) => !known.has(id)).map((id) => ({ id, status: "unknown", distanceKm: null }))];
  const result = await findNearestInStock({
    nearby: seed,
    user,
    catalog: catalog.stores,
    fetchAround: (lat, lon) => findStoresAround(lat, lon, itemId),
    onProgress: reportProgress,
    maxCalls: SEARCH_MAX_CALLS,
    gapMs: SEARCH_GAP_MS,
  });
  return result;
}

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
    case "findInStock": {
      if (!Array.isArray(msg.nearby)) return { ok: false, code: "unknown", error: "findInStock needs the nearby store list." };
      return { ok: true, ...(await findInStock(msg)) };
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
