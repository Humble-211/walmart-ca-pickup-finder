import { parseItemId } from "../lib/parse-item-id.js";
import { normalizePostalCode } from "../lib/postal-code.js";

const $ = (id) => document.getElementById(id);
const STATUS_LABEL = { available: "In stock", out_of_stock: "Out of stock", unknown: "Unknown" };

const state = { item: null, postalCode: "" };

function showError(msg) { $("error").textContent = msg; $("error").hidden = !msg; }
function showStatus(msg) { $("status").textContent = msg; $("status").hidden = !msg; }

function renderItem(item) {
  $("itemCard").hidden = false;
  $("itemImage").src = item.imageUrl ?? "";
  $("itemImage").hidden = !item.imageUrl;
  $("itemName").textContent = item.name;
  $("itemName").href = item.url;
  $("itemPrice").textContent = item.priceString;
  $("itemNotice").hidden = item.pickupEligible;
}

function renderStores(stores) {
  const list = $("stores");
  list.replaceChildren();
  const tpl = $("storeRow");
  for (const s of stores) {
    const li = tpl.content.firstElementChild.cloneNode(true);
    li.querySelector(".store-name").textContent = s.name;
    li.querySelector(".store-address").textContent = s.address;
    const badge = li.querySelector(".badge");
    badge.textContent = STATUS_LABEL[s.status] ?? STATUS_LABEL.unknown;
    badge.classList.add(s.status);
    li.querySelector(".distance").textContent = s.distanceKm == null ? "" : `${s.distanceKm.toFixed(1)} km`;
    const btn = li.querySelector(".pickup");
    btn.disabled = !s.accessPointId;
    btn.addEventListener("click", () => orderPickup(s, btn));
    list.append(li);
  }
  if (!stores.length) showStatus("No pickup stores found near that postal code.");
}

async function orderPickup(store, btn) {
  btn.disabled = true;
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
    btn.disabled = false;
  }
}

async function lookup(itemId, postalCode) {
  $("submit").disabled = true;
  showError("");
  showStatus("Looking up…");
  $("itemCard").hidden = true;
  $("stores").replaceChildren();
  try {
    const res = await chrome.runtime.sendMessage({ type: "lookup", itemId, postalCode });
    if (!res?.ok) { showStatus(""); showError(res?.error ?? "Lookup failed."); return; }
    state.item = res.item;
    state.postalCode = postalCode;
    showStatus("");
    renderItem(res.item);
    renderStores(res.stores);
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
  if (!itemId) { showError("Enter a walmart.ca item ID or product URL."); return; }
  const postalCode = normalizePostalCode($("postal").value);
  if (!postalCode) { showError("Enter a valid Canadian postal code (e.g. M5V 3L9)."); return; }
  $("postal").value = postalCode;
  chrome.storage.local.set({ postalCode });
  lookup(itemId, postalCode);
});

chrome.storage.local.get("postalCode").then(({ postalCode }) => {
  if (postalCode) $("postal").value = postalCode;
});
