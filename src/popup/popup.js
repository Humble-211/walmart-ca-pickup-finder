// The popup is a view over the job the background worker owns (src/lib/job.js): it starts or
// continues a job and renders whatever job state is stored, re-rendering on every change.
// Chrome destroys the popup document as soon as it loses focus, so nothing here may hold
// state that the work depends on.
import { parseProductUrl, RETAILERS } from "../retailers/index.js";
import { normalizePostalCode } from "../lib/postal-code.js";
import { formatError } from "../lib/errors.js";
import { deliveryText } from "../lib/delivery.js";
import { JOB_KEY } from "../lib/job.js";

const $ = (id) => document.getElementById(id);
const STATUS_LABEL = { available: "In stock", out_of_stock: "Out of stock", unknown: "Unknown" };
const NEAREST_SHOWN = 3;

let job = null; // the last rendered job, for the store-row buttons

// The store labels the registry supports, for the label hint and the unsupported-site message.
function storesList() {
  const labels = Object.values(RETAILERS).map((a) => a.label);
  return new Intl.ListFormat("en", { type: "conjunction" }).format(labels);
}

// Formats a message from the background/content script for display, filling in
// {host}/{label}/{stores} placeholders from the retailer that raised it.
function apiError(error, retailer, fallback) {
  return formatError(error ?? fallback, { ...RETAILERS[retailer], stores: storesList() });
}

function showError(msg) { $("error").textContent = msg; $("error").hidden = !msg; }
function showStatus(msg) { $("status").textContent = msg; $("status").hidden = !msg; }

function renderItem(item) {
  $("itemCard").hidden = !item;
  if (!item) return;
  $("itemImage").src = item.imageUrl ?? "";
  $("itemImage").hidden = !item.imageUrl;
  $("itemName").textContent = `${RETAILERS[item.retailer]?.label ?? ""} · ${item.name}`.replace(/^ · /, "");
  $("itemName").href = item.url;
  $("itemPrice").textContent = item.priceString;
  $("itemNotice").hidden = item.pickupEligible;
  renderDelivery(item.delivery, job?.postalCode);
}

function renderDelivery(delivery, postalCode) {
  const el = $("itemDelivery");
  const text = deliveryText(delivery, postalCode);
  el.textContent = text;
  el.hidden = !text;
  el.className = `delivery ${delivery?.status ?? ""}`.trim();
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
  if (job?.retailer === "walmart") {
    btn.textContent = "Order pickup";
    btn.disabled = !s.accessPointId;
    btn.addEventListener("click", () => orderPickup(s));
  } else {
    btn.textContent = "Open product page";
    btn.disabled = !s.url;
    btn.addEventListener("click", () => chrome.tabs.create({ url: s.url }));
  }
  return li;
}

// Status line for a job without an error: what the worker is doing, or why there is nothing to show.
function statusText(j) {
  const label = RETAILERS[j.retailer]?.label ?? "pickup";
  if (j.phase === "lookup") return "Looking up…";
  if (j.phase === "searching") return j.search ? `Searching farther stores… ${j.search.searched} checked, ${j.search.remaining} to go` : "Searching farther stores…";
  if (j.item && !j.nearby.length) {
    if (j.item.pickupEligible === false) return "This item is not offered for store pickup."; // the item notice stays visible: it is the reason
    if (!j.search) return `No ${label} pickup store found near that postal code.`;
  }
  return "";
}

// Note under the nearest-in-stock list, and whether "Keep searching farther" applies.
function nearestNote(j) {
  const label = RETAILERS[j.retailer]?.label ?? "This store";
  const host = RETAILERS[j.retailer]?.host ?? "the site";
  const s = j.search;
  if (j.phase === "interrupted") return { text: "The search was interrupted (the browser paused the extension). Keep searching to continue.", more: true };
  if (j.phase === "error" && j.item) return { text: "", more: true };
  if (!s) return { text: "", more: false };
  if (s.noLocation) return { text: "Could not work out where you are relative to the store list, so only nearby stores were checked.", more: false };
  if (s.rateLimited) return { text: `${host} rate-limited the search after ${s.searched} stores. Wait a minute or two, then keep searching.`, more: true };
  if (!j.inStock.length && s.complete) return { text: `No ${label} in Canada has this in stock for pickup (checked ${s.searched} stores).`, more: false };
  if (!j.inStock.length) return { text: `None of the ${s.searched} nearest stores have it in stock.`, more: true };
  if (!s.complete) return { text: `Closest found so far (${s.searched} stores checked). A closer store may still turn up.`, more: true };
  return { text: "", more: false };
}

function render(j) {
  job = j;
  const busy = j?.phase === "lookup" || j?.phase === "searching";
  $("submit").disabled = busy;
  if (!j) {
    renderItem(null);
    $("stores").replaceChildren();
    $("nearbyHeading").hidden = true;
    $("nearest").hidden = true;
    showStatus("");
    return;
  }
  if (!$("item").value && j.input) $("item").value = j.input;
  renderItem(j.item);
  $("stores").replaceChildren(...j.nearby.map(storeRow));
  $("nearbyHeading").hidden = !j.nearby.length;
  // Per-store availability outranks the buy box's pickup flag (a marketplace offer can hide it).
  if (j.nearby.some((s) => s.status !== "unknown")) $("itemNotice").hidden = true;
  const showNearest = Boolean(j.item) && (j.search != null || j.phase === "interrupted" || (j.phase === "error" && j.nearby.length > 0));
  $("nearest").hidden = !showNearest;
  $("nearestStores").replaceChildren(...j.inStock.slice(0, NEAREST_SHOWN).map(storeRow));
  const { text, more } = nearestNote(j);
  $("nearestNote").textContent = text;
  $("nearestNote").hidden = !text;
  $("searchMore").hidden = !more;
  $("searchMore").disabled = busy;
  showStatus(statusText(j));
  showError(j.phase === "error" ? apiError(j.error?.message, j.retailer, j.item ? "Search failed." : "Lookup failed.") : "");
}

async function orderPickup(store) {
  const buttons = [...document.querySelectorAll(".pickup")];
  const prev = buttons.map((b) => b.disabled);
  buttons.forEach((b) => (b.disabled = true));
  showError("");
  showStatus(`Selecting ${store.name}…`);
  try {
    const res = await chrome.runtime.sendMessage({
      type: "selectStore", retailer: job.retailer, store, postalCode: job.postalCode, itemUrl: job.item.url,
    });
    if (res?.ok) showStatus(`Opened product page with ${store.name} selected.`);
    else {
      showStatus("");
      showError(apiError(res?.error ? `${res.error} The product page was opened; pick the store there.` : "Failed to select store.", job.retailer));
    }
  } catch (err) {
    showStatus("");
    showError(String(err?.message ?? err));
  } finally {
    buttons.forEach((b, i) => (b.disabled = prev[i]));
  }
}

async function send(msg) {
  try {
    const res = await chrome.runtime.sendMessage(msg);
    if (!res?.ok) { showError(apiError(res?.error, msg.retailer, "Something went wrong.")); return; }
    render(res.job);
  } catch (err) {
    showError(String(err?.message ?? err));
  }
}

$("form").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const input = $("item").value;
  const parsed = parseProductUrl(input);
  if (!parsed) { render(null); showError(`Paste a product URL from ${storesList()} (or a Walmart item ID).`); return; }
  const postalCode = normalizePostalCode($("postal").value);
  if (!postalCode) { render(null); showError("Enter a valid Canadian postal code (e.g. M5V 3L9)."); return; }
  $("postal").value = postalCode;
  chrome.storage.local.set({ postalCode });
  showError("");
  send({ type: "startJob", retailer: parsed.retailer, itemId: parsed.itemId, postalCode, input: input.trim() });
});

$("searchMore").addEventListener("click", () => send({ type: "continueJob" }));

// Every step the worker persists shows up here, whether or not this popup started the job.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes[JOB_KEY]) render(changes[JOB_KEY].newValue ?? null);
});

chrome.storage.local.get("postalCode").then(({ postalCode }) => {
  if (postalCode && !$("postal").value) $("postal").value = postalCode;
});
send({ type: "getJob" });

$("itemLabelStores").textContent = `(${storesList()})`;
