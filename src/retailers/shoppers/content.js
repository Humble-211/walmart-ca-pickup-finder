// Runs on https://www.shoppersdrugmart.ca/*. Answers messages from the background worker.
import * as api from "./api.js";
import { searchInStock } from "./search.js";
import catalog from "./stores-ca.json";
import { locatePostalCode } from "../../lib/fsa.js";
import { locateUser } from "../../lib/geo.js";
import { toErrorResponse, WalmartApiError } from "../../lib/errors.js";

// The store endpoint takes coordinates only, so a postal code is located by its FSA centroid.
function locate(postalCode) {
  const user = locatePostalCode(postalCode);
  if (!user) throw new WalmartApiError("invalid_postal");
  return user;
}

// Nearby distances are measured from the FSA centroid, so trilaterating them against the
// catalog lands back on it: a fallback for a findInStock without a postal code.
const catalogById = new Map(catalog.stores.map((s) => [s.id, s]));

// Item ids the popup pasted -> the variant code the product endpoint resolved them to
// (only differs for the rare base code that is not itself a variant).
const resolved = new Map();

function reportProgress(progress) {
  chrome.runtime.sendMessage({ type: "searchProgress", ...progress }).catch(() => {});
}

async function handle(msg) {
  switch (msg?.type) {
    case "ping":
      return { ok: true };
    case "lookup": {
      const user = locate(msg.postalCode);
      const item = await api.getItem(msg.itemId);
      resolved.set(msg.itemId, item.id);
      const [stores, delivery] = await Promise.all([api.getStoreStock(item.id, user, false), api.getDelivery(item.id, msg.postalCode)]);
      return { ok: true, item: { ...item, delivery }, stores: stores.map((s) => ({ ...s, url: item.url })) };
    }
    case "findInStock": {
      if (!Array.isArray(msg.nearby)) return { ok: false, code: "unknown", error: "findInStock needs the nearby store list." };
      const result = await searchInStock({
        code: resolved.get(msg.itemId) ?? msg.itemId, user: locatePostalCode(msg.postalCode) ?? locateUser(msg.nearby, catalogById), nearby: msg.nearby, checkedIds: msg.checkedIds ?? [],
        onProgress: reportProgress, api, catalog: catalog.stores,
        productUrl: msg.itemUrl ?? `https://www.shoppersdrugmart.ca/p/BB_${encodeURIComponent(msg.itemId)}`,
      });
      return { ok: true, ...result };
    }
    case "selectStore":
      return { ok: false, code: "unsupported", error: "Shoppers Drug Mart does not support selecting a store from here; open the product page instead." };
    default:
      return { ok: false, code: "unknown", error: `Unknown message type: ${msg?.type}` };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handle(msg).then(sendResponse, (err) => sendResponse(toErrorResponse(err)));
  return true;
});
