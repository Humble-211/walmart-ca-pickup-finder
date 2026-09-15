// staples.ca endpoints (Shopify storefront + Staples inventory API). No cookies or
// headers beyond Content-Type are needed; the inventory endpoint's CORS rejects
// credentialed requests, so every call uses credentials: "omit".
// Endpoint details: docs/staples-ca-endpoints.md
import { parseProduct, parseAvailability } from "./parse.js";
import { WalmartApiError, apiChanged } from "../../lib/errors.js";

const ORIGIN = "https://www.staples.ca";
export const AVAILABILITY_URL = "https://api.staples.ca/ecommerce/inventory/v2.0/request";

export function buildProductUrl(handle) {
  return `${ORIGIN}/products/${encodeURIComponent(String(handle))}.js`;
}

export function buildAvailabilityBody(sku, postalCode) {
  return { locale: "en-CA", postal_code: postalCode, items: [{ sku: String(sku), quantity: 1000 }], location: "PickInStore" };
}

async function request(url, init = {}) {
  const res = await globalThis.fetch(url, { credentials: "omit", ...init, headers: { accept: "application/json", ...(init.headers ?? {}) } });
  const text = await res.text();
  const contentType = res.headers.get("content-type") ?? "";
  // Check the specific status codes before the HTML/403 sniff, so e.g. a 404 served as an
  // HTML error page (Cloudflare, a CDN 404, …) still maps to "not_found" rather than being
  // mistaken for a bot-verification challenge.
  if (res.status === 404) throw new WalmartApiError("not_found");
  if (res.status === 429) throw new WalmartApiError("rate_limited");
  if (res.status === 400 && /PostalCode/.test(text)) throw new WalmartApiError("invalid_postal");
  if (res.status === 403 || /text\/html/i.test(contentType) || /^\s*</.test(text)) throw new WalmartApiError("verification");
  let json;
  try { json = JSON.parse(text); } catch { throw apiChanged(text); }
  if (!res.ok) throw apiChanged(text);
  return json;
}

export async function getItem(handle) {
  return parseProduct(await request(buildProductUrl(handle)), handle);
}

// The 5 nearest pickup stores to postalCode with live stock for sku (see parseAvailability).
export async function getAvailability(sku, postalCode) {
  const json = await request(AVAILABILITY_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(buildAvailabilityBody(sku, postalCode)),
  });
  return parseAvailability(json, sku);
}
