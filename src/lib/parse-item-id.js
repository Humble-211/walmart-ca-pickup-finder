// Extracts a walmart.ca item ID from a bare ID or a product URL.
// walmart.ca product URLs look like /en/ip/<slug>/<id> or /en/ip/<id>.
const BARE_ID = /^\d{6,}$/;
const URL_ID = /\/ip\/(?:[^/?#]+\/)?(\d{6,})(?=[/?#]|$)/;

export function parseItemId(input) {
  const s = String(input ?? "").trim();
  if (!s) return null;
  if (BARE_ID.test(s)) return s;
  const m = s.match(URL_ID);
  return m ? m[1] : null;
}
