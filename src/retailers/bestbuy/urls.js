// bestbuy.ca product URLs: /en-ca/product/<slug>/<sku> or /fr-ca/produit/<slug>/<sku>; sku is numeric.
const URL_SKU = /^https?:\/\/(?:www\.)?bestbuy\.ca\/(?:en|fr)-ca\/(?:product|produit)\/(?:[^/?#]+\/)?(\d{5,10})(?=[/?#]|$)/i;

export const id = "bestbuy";
export const label = "Best Buy";
export const host = "www.bestbuy.ca";
export const homeUrl = "https://www.bestbuy.ca/en-ca";

export function parseProductUrl(input) {
  const m = String(input ?? "").trim().match(URL_SKU);
  return m ? m[1] : null;
}
