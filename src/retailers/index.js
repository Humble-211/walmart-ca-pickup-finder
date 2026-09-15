// Registry of retailer adapters. Each entry is the adapter's pure `urls.js`
// (safe for popup and background: no network, no chrome APIs).
import * as walmart from "./walmart/urls.js";

export const RETAILERS = Object.fromEntries([walmart].map((a) => [a.id, a]));

// Adapters are tried in registry order; walmart is last because it also
// accepts bare ids, which no other adapter does.
const ORDER = [...Object.values(RETAILERS).filter((a) => a.id !== "walmart"), walmart];

export function parseProductUrl(input) {
  const s = String(input ?? "").trim();
  if (!s) return null;
  for (const a of ORDER) {
    const itemId = a.parseProductUrl(s);
    if (itemId) return { retailer: a.id, itemId };
  }
  return null;
}
