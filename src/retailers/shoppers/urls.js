// shoppersdrugmart.ca product URLs: /<slug>/p/BB_<code>?variantCode=<code>. The base
// code (after "BB_") identifies the product; sized/coloured products carry the selected
// variant in ?variantCode. Every stock and product endpoint keys on the variant code,
// and the base code doubles as the default variant's code, so the item id is
// variantCode when present, else the base code. Docs: docs/shoppers-ca-endpoints.md §1
const URL_CODE = /^https?:\/\/(?:www\.)?shoppersdrugmart\.ca\/(?:[^?#]*\/)?p\/BB_([a-z0-9]+)(?=[/?#]|$)/i;
const VARIANT = /[?&]variantCode=([a-z0-9]+)/i;

export const id = "shoppers";
export const label = "Shoppers Drug Mart";
export const host = "www.shoppersdrugmart.ca";
export const homeUrl = "https://www.shoppersdrugmart.ca/";

export function parseProductUrl(input) {
  const s = String(input ?? "").trim();
  const m = s.match(URL_CODE);
  if (!m) return null;
  const v = s.match(VARIANT);
  return (v ? v[1] : m[1]).toUpperCase();
}
