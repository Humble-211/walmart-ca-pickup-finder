// shoppersdrugmart.ca endpoints (Loblaw "beauty/v2" API). Every call needs the site's
// public x-apikey and must carry the site cookies (credentials: "include"): Akamai
// answers cookie-less requests with a 403 HTML page. Endpoint details:
// docs/shoppers-ca-endpoints.md
import { parseProduct, parseStoreDetails, parseDelivery } from "./parse.js";
import { WalmartApiError, apiChanged } from "../../lib/errors.js";

const API = "https://api.shoppersdrugmart.ca/beauty/v2/shoppersdrugmart";
export const API_KEY = "r3kEMAxRsQQtyjXiIJOTFNN75vcsJFxH";
export const STORE_DETAILS_URL = `${API}/store-locator/store-details?lang=en`;

export function buildProductUrl(code) {
  return `${API}/product/variantProduct/${encodeURIComponent(String(code))}/details`;
}

// The postal code goes without its space, as the site sends it.
export function buildDeliveryUrl(code, postalCode) {
  return `${API}/product/${encodeURIComponent(String(code))}/fulfillment-options?${new URLSearchParams({ storeId: "", postalCode: String(postalCode).replace(/\s+/g, "") })}`;
}

export function buildBaseProductUrl(code) {
  return `${API}/product/baseProduct/BB_${encodeURIComponent(String(code))}/details`;
}

// inStockOnly: true asks for the nearest stores that have stock; false for the nearest stores, any stock.
export function buildStoreDetailsBody(code, { lat, lon }, inStockOnly = false) {
  return { latitude: lat, longitude: lon, productId: String(code), inStock: Boolean(inStockOnly), storeType: 1 };
}

// When Akamai rejects a request it answers with a 403 HTML page that carries no CORS
// headers, so the browser surfaces it to the content script as a TypeError rather than
// a status code. That happens for automated browsers (navigator.webdriver) and, for the
// first ~12 s, in a tab the extension has just opened in the background (the site's
// bot-protection script boots slowly there), so a TypeError is retried for a while
// before it is reported.
const BLOCKED = "Shoppers Drug Mart's bot protection blocked the request from this tab. Reload the {host} tab, open any product page there, then retry.";
export const RETRY = { attempts: 5, delayMs: 3000 };

async function request(url, init = {}, attempt = 0) {
  let res;
  try {
    res = await globalThis.fetch(url, {
      credentials: "include", ...init,
      headers: { accept: "application/json", "x-apikey": API_KEY, language: "en", ...(init.headers ?? {}) },
    });
  } catch (err) {
    if (!(err instanceof TypeError)) throw err;
    if (attempt >= RETRY.attempts) throw new WalmartApiError("verification", BLOCKED);
    await new Promise((r) => setTimeout(r, RETRY.delayMs));
    return request(url, init, attempt + 1);
  }
  const text = await res.text();
  const contentType = res.headers.get("content-type") ?? "";
  if (res.status === 204) return null;
  if (res.status === 404) throw new WalmartApiError("not_found");
  if (res.status === 429) throw new WalmartApiError("rate_limited");
  if (res.status === 403 || /text\/html/i.test(contentType) || /^\s*</.test(text)) throw new WalmartApiError("verification");
  let json;
  try { json = JSON.parse(text); } catch { throw apiChanged(text); }
  if (!res.ok) throw apiChanged(text); // 400/401/422: bad request or a rotated api key
  return json;
}

// Variant details for `code`. A base code that is not itself a variant (rare) is resolved
// through the base product's first variant.
export async function getItem(code) {
  try {
    return parseProduct(await request(buildProductUrl(code)), code);
  } catch (err) {
    if (err?.code !== "not_found") throw err;
    const base = await request(buildBaseProductUrl(code));
    const first = base?.variantsSummary?.variantOptions?.[0]?.code;
    if (!first || String(first) === String(code)) throw err;
    return parseProduct(await request(buildProductUrl(first)), first);
  }
}

// The up-to-10 nearest stores to `centre` (within ~20 km) with live stock for `code`.
// With inStockOnly, only stores that have stock are returned (still capped at 10).
export async function getStoreStock(code, centre, inStockOnly = false) {
  const json = await request(STORE_DETAILS_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(buildStoreDetailsBody(code, centre, inStockOnly)),
  });
  return parseStoreDetails(json);
}

// Ship-to-home availability, quantity and delivery estimate for the variant code at postalCode.
export async function getDelivery(code, postalCode) {
  return parseDelivery(await request(buildDeliveryUrl(code, postalCode)));
}
