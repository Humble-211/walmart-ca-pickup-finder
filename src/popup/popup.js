import { parseProductUrl, RETAILERS } from "../retailers/index.js";
import { normalizePostalCode } from "../lib/postal-code.js";
import { formatError } from "../lib/errors.js";

const $ = (id) => document.getElementById(id);
const STATUS_LABEL = { available: "In stock", out_of_stock: "Out of stock", unknown: "Unknown" };
const NEAREST_SHOWN = 3;

const state = { item: null, postalCode: "", itemId: "", retailer: "", nearby: [], inStock: [], checkedIds: [], searching: false };

// The store labels the registry supports, for the label hint and the unsupported-site message.
function storesList() {
  const labels = Object.values(RETAILERS).map((a) => a.label);
  return new Intl.ListFormat("en", { type: "conjunction" }).format(labels);
}

// Formats a message from the background/content script for display, filling in
// {host}/{label}/{stores} placeholders from the retailer that raised it.
function showApiError(error, retailer, fallback) {
  showError(formatError(error ?? fallback, { ...RETAILERS[retailer], stores: storesList() }));
}

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
  $("itemName").textContent = `${RETAILERS[item.retailer]?.label ?? ""} · ${item.name}`.replace(/^ · /, "");
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
  if (state.retailer === "walmart") {
    btn.textContent = "Order pickup";
    btn.disabled = !s.accessPointId;
    btn.addEventListener("click", () => orderPickup(s, btn));
  } else {
    btn.textContent = "Open product page";
    btn.disabled = !s.url;
    btn.addEventListener("click", () => chrome.tabs.create({ url: s.url }));
  }
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
  const label = RETAILERS[state.retailer]?.label ?? "This store";
  const host = RETAILERS[state.retailer]?.host ?? "the site";
  if (res.noLocation) text = "Could not work out where you are relative to the store list, so only nearby stores were checked.";
  else if (res.rateLimited) text = `${host} rate-limited the search after ${res.searched} stores. Wait a minute or two, then keep searching.`;
  else if (!state.inStock.length && res.complete) text = `No ${label} in Canada has this in stock for pickup (checked ${res.searched} stores).`;
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
      type: "selectStore", retailer: state.retailer, store, postalCode: state.postalCode, itemUrl: state.item.url,
    });
    if (res?.ok) showStatus(`Opened product page with ${store.name} selected.`);
    else {
      showStatus("");
      showApiError(res?.error ? `${res.error} The product page was opened; pick the store there.` : "Failed to select store.", state.retailer);
    }
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
      type: "findInStock", retailer: state.retailer, itemId: state.itemId, nearby: state.nearby, checkedIds: state.checkedIds,
      itemUrl: state.item.url,
    });
    showStatus("");
    if (!res?.ok) { showApiError(res?.error, state.retailer, "Search failed."); return; }
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

async function lookup({ retailer, itemId }, postalCode) {
  $("submit").disabled = true;
  showError("");
  showStatus("Looking up…");
  clearResults();
  try {
    const res = await chrome.runtime.sendMessage({ type: "lookup", retailer, itemId, postalCode });
    if (!res?.ok) { showStatus(""); showApiError(res?.error, retailer, "Lookup failed."); return; }
    state.item = res.item;
    state.itemId = itemId;
    state.retailer = retailer;
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
  const parsed = parseProductUrl($("item").value);
  if (!parsed) { clearResults(); showError(`Paste a product URL from ${storesList()} (or a Walmart item ID).`); return; }
  const postalCode = normalizePostalCode($("postal").value);
  if (!postalCode) { clearResults(); showError("Enter a valid Canadian postal code (e.g. M5V 3L9)."); return; }
  $("postal").value = postalCode;
  chrome.storage.local.set({ postalCode });
  lookup(parsed, postalCode);
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

$("itemLabelStores").textContent = `(${storesList()})`;
