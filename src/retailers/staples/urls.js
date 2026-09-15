// staples.ca product URLs: /products/<handle> or /fr/products/<handle>, where the
// Shopify handle is "<sku>-<lang>-<slug>" and the sku is the leading digits (5-8 seen).
// The slug is load-bearing (the product endpoint needs the full handle), so the
// item id IS the handle. Docs: docs/staples-ca-endpoints.md §1
const URL_HANDLE = /^https?:\/\/(?:www\.)?staples\.ca\/(?:fr\/)?products\/(\d{4,10}-[a-z]{2}-[a-z0-9-]+)(?=[/?#]|$)/i;
const HANDLE_SKU = /^(\d{4,10})-/;

export const id = "staples";
export const label = "Staples";
export const host = "www.staples.ca";
export const homeUrl = "https://www.staples.ca/";

export function parseProductUrl(input) {
  const m = String(input ?? "").trim().match(URL_HANDLE);
  return m ? m[1] : null;
}

export function skuFromHandle(handle) {
  const m = String(handle ?? "").match(HANDLE_SKU);
  return m ? m[1] : null;
}
