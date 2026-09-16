// The restock monitor's settings and watchlist. Every change goes through the
// background worker, which owns the storage, so two open copies of this page
// cannot write over each other.
const $ = (id) => document.getElementById(id);
const STATUS_LABEL = { available: "In stock", out_of_stock: "Out of stock", unknown: "Unknown" };

const send = (msg) => chrome.runtime.sendMessage(msg);

function when(ts) {
  if (!ts) return "never";
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins <= 0) return "just now";
  if (mins < 60) return `${mins} min ago`;
  return `${Math.round(mins / 60)} h ago`;
}

function rateNote(watches, intervalMinutes) {
  const active = watches.filter((w) => !w.paused).length;
  if (!active) return "Nothing is being checked.";
  const per5 = ((active * 5) / intervalMinutes).toFixed(1);
  return `About ${per5} checks every 5 minutes. Walmart starts refusing at roughly 25, so keep some room for your own searches.`;
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
  pause.addEventListener("click", async () => { await send({ type: "pauseWatch", id: w.id, paused: !w.paused }); load(); });
  li.querySelector(".remove").addEventListener("click", async () => { await send({ type: "removeWatch", id: w.id }); load(); });
  return li;
}

function render({ watches, settings }) {
  $("token").value = settings.telegram?.token ?? "";
  $("chatId").value = settings.telegram?.chatId ?? "";
  $("enabled").checked = Boolean(settings.enabled);
  $("interval").value = settings.intervalMinutes;
  $("rate").textContent = rateNote(watches, settings.intervalMinutes);
  $("empty").hidden = watches.length > 0;
  $("watches").replaceChildren(...watches.map(watchRow));
}

async function load() {
  const res = await send({ type: "getWatchState" });
  if (res?.ok) render(res);
}

async function saveSettings() {
  const token = $("token").value.trim();
  const chatId = $("chatId").value.trim();
  const intervalMinutes = Math.min(60, Math.max(1, Number($("interval").value) || 5));
  await send({
    type: "setWatchSettings",
    settings: { enabled: $("enabled").checked, intervalMinutes, telegram: token && chatId ? { token, chatId } : null },
  });
  load();
}

for (const id of ["token", "chatId", "interval"]) $(id).addEventListener("change", saveSettings);
$("enabled").addEventListener("change", saveSettings);

$("test").addEventListener("click", async () => {
  await saveSettings();
  $("test").disabled = true;
  const res = await send({ type: "testTelegram" });
  $("testResult").textContent = res?.ok ? "Sent. Check Telegram." : `Failed: ${res?.error ?? "unknown error"}`;
  $("testResult").hidden = false;
  $("test").disabled = false;
});

load();
