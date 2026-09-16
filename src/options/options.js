// The restock monitor's settings and watchlist. Every change goes through the
// background worker, which owns the storage, so two open copies of this page
// cannot write over each other.
import { rateNote, telegramSettings } from "../lib/watch.js";
import { formatError } from "../lib/errors.js";
import { RETAILERS } from "../retailers/index.js";

const $ = (id) => document.getElementById(id);
const STATUS_LABEL = { available: "In stock", out_of_stock: "Out of stock", unknown: "Unknown" };

function showPageError(msg) {
  const el = $("pageError");
  el.textContent = msg ?? "";
  el.hidden = !msg;
}

// What to show a person for a failed response. Two things happen here.
//
// The error templates in lib/errors.js carry {host}/{label}/{stores} placeholders
// that only a display site fills in, so anything shown raw reads like "Paste a
// product URL from {stores}".
//
// And `unsupported` has exactly one meaning on this page. Every message it sends
// is answered before background.js reaches its retailer check, so the only way to
// get that code back is a background worker that does not know the message at all,
// which means it is older than this page. Chrome serves these page files from disk
// on every open but keeps running the service worker it registered when the
// extension was last loaded, so rebuilding without reloading the extension lands
// precisely here.
const storesList = () =>
  new Intl.ListFormat("en", { type: "conjunction" }).format(Object.values(RETAILERS).map((a) => a.label));

function errorText(res, fallback = "Something went wrong.") {
  if (res?.code === "unsupported") {
    return "The extension's background worker is older than this page. Open chrome://extensions, press reload on this extension, then try again.";
  }
  return formatError(res?.error ?? fallback, { stores: storesList() });
}

async function send(msg) {
  try {
    const res = await chrome.runtime.sendMessage(msg);
    if (res && res.ok === false) showPageError(errorText(res));
    return res;
  } catch (err) {
    showPageError(String(err?.message ?? err));
    return { ok: false, error: String(err?.message ?? err) };
  }
}

function when(ts) {
  if (!ts) return "never";
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins <= 0) return "just now";
  if (mins < 60) return `${mins} min ago`;
  return `${Math.round(mins / 60)} h ago`;
}

function watchRow(w) {
  const li = $("watchRow").content.firstElementChild.cloneNode(true);
  const name = li.querySelector(".watch-name");
  name.textContent = w.name ?? w.input;
  if (w.url) name.href = w.url;
  li.querySelector(".watch-meta").textContent =
    [w.retailer, w.priceString, `to ${w.postalCode}`, `checked ${when(w.lastCheckedAt)}`].filter(Boolean).join(" · ");
  const error = li.querySelector(".watch-error");
  if (w.lastError) {
    error.textContent = `${w.lastError.message} (${w.failures} in a row)`;
    error.hidden = false;
  }
  const badge = li.querySelector(".badge");
  badge.textContent = w.paused ? "Paused" : (STATUS_LABEL[w.status] ?? "Not checked yet");
  badge.classList.add(w.status ?? "never");
  const pause = li.querySelector(".pause");
  pause.textContent = w.paused ? "Resume" : "Pause";
  pause.addEventListener("click", async () => { const res = await send({ type: "pauseWatch", id: w.id, paused: !w.paused }); if (res?.ok) load(); });
  li.querySelector(".remove").addEventListener("click", async () => { const res = await send({ type: "removeWatch", id: w.id }); if (res?.ok) load(); });
  return li;
}

// Never write over the field the user is currently in. A save fires when they
// leave one field, and its reply lands while they are already typing in the next
// one; without this guard that reply overwrites what they are in the middle of.
function setField(id, value) {
  const el = $(id);
  if (document.activeElement !== el) el.value = value;
}

function render({ watches, settings }) {
  setField("token", settings.telegram?.token ?? "");
  setField("chatId", settings.telegram?.chatId ?? "");
  $("enabled").checked = Boolean(settings.enabled);
  setField("interval", settings.intervalMinutes);
  $("rate").textContent = rateNote(watches);
  $("empty").hidden = watches.length > 0;
  $("watches").replaceChildren(...watches.map(watchRow));
}

async function load() {
  const res = await send({ type: "getWatchState" });
  if (res?.ok) {
    showPageError("");
    render(res);
  }
}

async function saveSettings() {
  const token = $("token").value.trim();
  const chatId = $("chatId").value.trim();
  const intervalMinutes = Math.min(60, Math.max(1, Number($("interval").value) || 5));
  const res = await send({
    type: "setWatchSettings",
    settings: { enabled: $("enabled").checked, intervalMinutes, telegram: telegramSettings(token, chatId) },
  });
  if (res?.ok) load();
}

for (const id of ["token", "chatId", "interval"]) $(id).addEventListener("change", saveSettings);
$("enabled").addEventListener("change", saveSettings);

$("test").addEventListener("click", async () => {
  await saveSettings();
  $("test").disabled = true;
  const res = await send({ type: "testTelegram" });
  $("testResult").textContent = res?.ok ? "Sent. Check Telegram." : `Failed: ${errorText(res, "unknown error")}`;
  $("testResult").hidden = false;
  $("test").disabled = false;
});

load();
