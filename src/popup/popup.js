import { parseItemId } from "../retailers/walmart/urls.js";
import { normalizePostalCode } from "../lib/postal-code.js";

const $ = (id) => document.getElementById(id);
const STATUS_LABEL = { available: "In stock", out_of_stock: "Out of stock", unknown: "Unknown" };
const NEAREST_SHOWN = 3;

const state = { item: null, postalCode: "", itemId: "", nearby: [], inStock: [], checkedIds: [], searching: false };

function showError(msg) { $("error").textContent = msg; $("error").hidden = !msg; }
function showStatus(msg) { $("status").textContent = msg; $("status").hidden = !msg; }
function clearResults() {
  $("itemCard").hidden = true;
  $("stores").replaceChildren();
  $("nearbyHeading").hidden = true;
  $("nearest").hidden = true;
  $("nearestStores").replaceChildren();
  $("nearestNote").hidden = true;
  $("searchMore").hidden = true;
  state.inStock = [];
  state.checkedIds = [];
}

function renderItem(item) {
  $("itemCard").hidden = false;
  $("itemImage").src = item.imageUrl ?? "";
  $("itemImage").hidden = !item.imageUrl;
  $("itemName").textContent = item.name;
  $("itemName").href = item.url;
  $("itemPrice").textContent = item.priceString;
  $("itemNotice").hidden = item.pickupEligible;
}

function storeRow(s) {
  const li = $("storeRow").content.firstElementChild.cloneNode(true);
  li.querySelector(".store-name").textContent = s.name;
  li.querySelector(".store-address").textContent = s.address;
  const badge = li.querySelector(".badge");
  badge.textContent = STATUS_LABEL[s.status] ?? STATUS_LABEL.unknown;
  badge.classList.add(s.status);
  li.querySelector(".distance").textContent = s.distanceKm == null ? "" : `${s.distanceKm.toFixed(1)} km`;
  const btn = li.querySelector(".pickup");
  btn.disabled = !s.accessPointId;
  btn.addEventListener("click", () => orderPickup(s, btn));
  return li;
}

function renderStores(stores) {
  $("stores").replaceChildren(...stores.map(storeRow));
  $("nearbyHeading").hidden = !stores.length;
  // Per-store availability outranks the buy box's pickup flag (a marketplace offer can hide it).
  if (stores.some((s) => s.status !== "unknown")) $("itemNotice").hidden = true;
  if (!stores.length) showStatus("No pickup stores found near that postal code.");
}

// res: result of a findInStock message (may be partial).
function renderNearest(res) {
  $("nearest").hidden = false;
  $("nearestStores").replaceChildren(...state.inStock.slice(0, NEAREST_SHOWN).map(storeRow));
  const note = $("nearestNote");
  let text = "";
  if (res.noLocation) text = "Could not work out where you are relative to the store list, so only nearby stores were checked.";
  else if (res.rateLimited) text = `walmart.ca rate-limited the search after ${res.searched} stores. Wait a minute or two, then keep searching.`;
  else if (!state.inStock.length && res.complete) text = `No Walmart in Canada has this in stock for pickup (checked ${res.searched} stores).`;
  else if (!state.inStock.length) text = `None of the ${res.searched} nearest stores have it in stock.`;
  else if (!res.complete) text = `Closest found so far (${res.searched} stores checked). A closer store may still turn up.`;
  note.textContent = text;
  note.hidden = !text;
  $("searchMore").hidden = res.complete || res.noLocation;
}

async function orderPickup(store, btn) {
  const buttons = [...document.querySelectorAll(".pickup")];
  const prev = buttons.map((b) => b.disabled);
  buttons.forEach((b) => (b.disabled = true));
  showError("");
  showStatus(`Selecting ${store.name}…`);
  try {
    const res = await chrome.runtime.sendMessage({
      type: "selectStore", store, postalCode: state.postalCode, itemUrl: state.item.url,
    });
    if (res?.ok) showStatus(`Opened product page with ${store.name} selected.`);
    else { showStatus(""); showError(`${res?.error ?? "Failed to select store."} The product page was opened; pick the store there.`); }
  } catch (err) {
    showStatus("");
    showError(String(err?.message ?? err));
  } finally {
    buttons.forEach((b, i) => (b.disabled = prev[i]));
  }
}

function mergeInStock(found) {
  const byId = new Map(state.inStock.map((s) => [s.id, s]));
  for (const s of found) byId.set(s.id, s);
  state.inStock = [...byId.values()].sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity));
}

// Looks beyond the nearby list for the closest stores with stock; continues an earlier search when called again.
async function searchInStock() {
  if (state.searching) return;
  state.searching = true;
  $("searchMore").disabled = true;
  showError("");
  showStatus("Searching farther stores…");
  try {
    const res = await chrome.runtime.sendMessage({
      type: "findInStock", itemId: state.itemId, nearby: state.nearby, checkedIds: state.checkedIds,
    });
    showStatus("");
    if (!res?.ok) { showError(res?.error ?? "Search failed."); return; }
    mergeInStock(res.inStock ?? []);
    state.checkedIds = res.checkedIds ?? state.checkedIds;
    renderNearest(res);
  } catch (err) {
    showStatus("");
    showError(String(err?.message ?? err));
  } finally {
    state.searching = false;
    $("searchMore").disabled = false;
  }
}

async function lookup(itemId, postalCode) {
  $("submit").disabled = true;
  showError("");
  showStatus("Looking up…");
  clearResults();
  try {
    const res = await chrome.runtime.sendMessage({ type: "lookup", itemId, postalCode });
    if (!res?.ok) { showStatus(""); showError(res?.error ?? "Lookup failed."); return; }
    state.item = res.item;
    state.itemId = itemId;
    state.postalCode = postalCode;
    state.nearby = res.stores;
    showStatus("");
    renderItem(res.item);
    renderStores(res.stores);
    // Only worth searching when walmart reports pickup availability for this item at all.
    if (res.stores.some((s) => s.status !== "unknown")) await searchInStock();
  } catch (err) {
    showStatus("");
    showError(String(err?.message ?? err));
  } finally {
    $("submit").disabled = false;
  }
}

$("form").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const itemId = parseItemId($("item").value);
  if (!itemId) { clearResults(); showError("Enter a walmart.ca item ID or product URL."); return; }
  const postalCode = normalizePostalCode($("postal").value);
  if (!postalCode) { clearResults(); showError("Enter a valid Canadian postal code (e.g. M5V 3L9)."); return; }
  $("postal").value = postalCode;
  chrome.storage.local.set({ postalCode });
  lookup(itemId, postalCode);
});

$("searchMore").addEventListener("click", searchInStock);

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "searchProgress" && state.searching) {
    showStatus(`Searching farther stores… ${msg.searched} checked, ${msg.remaining} to go`);
  }
});

chrome.storage.local.get("postalCode").then(({ postalCode }) => {
  if (postalCode) $("postal").value = postalCode;
});
