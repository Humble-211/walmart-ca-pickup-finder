// Extracts a walmart.ca item ID from a bare ID or a product URL.
// walmart.ca uses two ID forms: numeric (6+ digits, e.g. 6000208927194) and
// 12-character alphanumeric containing at least one digit (e.g. 1SZQHN3LOSE0).
// Product URLs look like /en/ip/<slug>/<id>, /fr/ip/<id> or /ip/<id>.
const ID = /(?:\d{6,}|(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{12})/.source;
const BARE_ID = new RegExp(`^${ID}$`);
const URL_ID = new RegExp(`/ip/(?:[^/?#]+/)?(${ID})(?=[/?#]|$)`);

export function parseItemId(input) {
  const s = String(input ?? "").trim();
  if (!s) return null;
  if (BARE_ID.test(s)) return s.toUpperCase();
  const m = s.match(URL_ID);
  return m ? m[1].toUpperCase() : null;
}
