// Sends one message through a Telegram bot. `fetch` is injected so tests never
// touch the network. Every failure comes back as a value, never as a throw: a
// Telegram outage must not be able to wedge the restock monitor's tick.
const ORIGIN = "https://api.telegram.org";

export async function sendMessage({ token, chatId, text }, { fetch = globalThis.fetch } = {}) {
  if (!token || !chatId) return { ok: false, error: "Telegram is not configured." };
  try {
    const res = await fetch(`${ORIGIN}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: String(chatId), text: String(text), disable_web_page_preview: false }),
    });
    let body = null;
    try { body = await res.json(); } catch { /* telegram sent something that is not JSON */ }
    if (body?.ok === true) return { ok: true };
    if (body?.description) return { ok: false, error: String(body.description) };
    return { ok: false, error: `Telegram returned HTTP ${res.status}.` };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
}
