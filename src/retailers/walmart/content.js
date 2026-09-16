// Runs on https://www.walmart.ca/*. Answers messages from the background worker.
import { getItem, findStores, findDeliveryStores, findStoresAround, selectStore } from "./api.js";
import { deliverySummary } from "./parse.js";
import { rankStores } from "../../lib/rank-stores.js";
import { locateUser } from "../../lib/geo.js";
import { findNearestInStock } from "../../lib/stock-search.js";
import { toErrorResponse } from "../../lib/errors.js";
import catalog from "./stores-ca.json";

const MAX_STORES = 10;
// walmart.ca rate-limits at roughly 25 calls per 5 minutes per browser, so one
// nationwide search is capped well below that. The popup can ask to continue.
const SEARCH_MAX_CALLS = 10;
const SEARCH_GAP_MS = 1000;
// Delivery is served by the nodes around the postal code; there is nothing farther to probe,
// so "keep searching" just widens the one call (walmart caps maxCount at 50).
const DELIVERY_STORES = 10;
const DELIVERY_STORES_WIDE = 50;

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

// deps are injected so tests can drive this without the network or chrome.
export async function handleMessage(msg, deps = {}) {
  const api = { getItem, findStores, findDeliveryStores, findInStock, selectStore, rankStores, ...deps };
  switch (msg?.type) {
    case "ping":
      return { ok: true };
    case "lookup": {
      if (msg.mode === "delivery") {
        const [item, stores] = await Promise.all([
          api.getItem(msg.itemId),
          api.findDeliveryStores(msg.postalCode, msg.itemId, DELIVERY_STORES),
        ]);
        const ranked = api.rankStores(stores);
        const withDelivery = { ...item, delivery: deliverySummary(ranked, item) };
        // A marketplace seller's item is stocked in none of walmart's own nodes, so the list
        // would be ten "Out of stock" rows about an item that ships. Drop it, and say the
        // answer is complete: widening the node count cannot change it.
        if (item.soldByThirdParty) return { ok: true, item: withDelivery, stores: [], complete: true };
        return { ok: true, item: withDelivery, stores: ranked, complete: false };
      }
      const [item, stores] = await Promise.all([
        api.getItem(msg.itemId),
        api.findStores(msg.postalCode, msg.itemId, MAX_STORES),
      ]);
      return { ok: true, item, stores: api.rankStores(stores) };
    }
    case "findInStock": {
      if (msg.mode === "delivery") {
        if (msg.item?.soldByThirdParty) {
          // Nothing to widen: no walmart node answers for this offer.
          return { ok: true, inStock: [], searched: 0, checkedIds: [], complete: true, rateLimited: false, delivery: deliverySummary([], msg.item) };
        }
        const stores = api.rankStores(await api.findDeliveryStores(msg.postalCode, msg.itemId, DELIVERY_STORES_WIDE));
        return {
          ok: true, inStock: stores.filter((s) => s.status === "available"), searched: stores.length,
          checkedIds: stores.map((s) => s.id), complete: true, rateLimited: false, delivery: deliverySummary(stores),
        };
      }
      if (!Array.isArray(msg.nearby)) return { ok: false, code: "unknown", error: "findInStock needs the nearby store list." };
      return { ok: true, ...(await api.findInStock(msg)) };
    }
    case "selectStore": {
      const { storeId } = await api.selectStore(msg.store, msg.postalCode);
      return { ok: true, storeId };
    }
    default:
      return { ok: false, code: "unknown", error: `Unknown message type: ${msg?.type}` };
  }
}

if (globalThis.chrome?.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    handleMessage(msg).then(sendResponse, (err) => sendResponse(toErrorResponse(err)));
    return true; // keep the channel open for the async response
  });
}
