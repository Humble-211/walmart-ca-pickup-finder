// bestbuy.ca REST endpoints. No cookies, headers or hashes are needed (docs/bestbuy-ca-endpoints.md),
// but the calls still run from the bestbuy.ca content script so every retailer works the same way.
import { parseProduct, parseStores, parseAvailability, parseShipping } from "./parse.js";
import { WalmartApiError, apiChanged } from "../../lib/errors.js";

const ORIGIN = "https://www.bestbuy.ca";
// The gateway accepts up to 96 ids per call (97 was rejected upstream); keep headroom.
export const LOCATIONS_PER_CALL = 90;

export function buildProductUrl(sku) {
  return `${ORIGIN}/api/v1/catalog/query?${new URLSearchParams({ ids: String(sku), lang: "en-CA" })}`;
}

export function buildStoresUrl(postalCode) {
  return `${ORIGIN}/api/v3/json/locations?${new URLSearchParams({ lang: "en-CA", postalCode, pageSize: "1000" })}`;
}

// The `accept` media type is a query parameter here, not a header; without it the
// response has no per-store locations.
// postalCode is optional: it only shapes the shipping part of the answer (delivery dates),
// so the lookup sends it and the nationwide search does not.
export function buildAvailabilityUrl(sku, locationIds, postalCode) {
  const q = new URLSearchParams({
    accept: "application/vnd.bestbuy.standardproduct.v1+json",
    "accept-language": "en-CA",
    locations: locationIds.join("|"),
    ...(postalCode ? { postalCode } : {}),
    skus: String(sku),
  });
  return `${ORIGIN}/ecomm-api/availability/products?${q}`;
}

async function get(url) {
  const res = await globalThis.fetch(url, { credentials: "omit", headers: { accept: "application/json" } });
  const text = await res.text();
  const contentType = res.headers.get("content-type") ?? "";
  if (res.status === 403 || /text\/html/i.test(contentType) || /^\s*</.test(text)) throw new WalmartApiError("verification");
  if (res.status === 429) throw new WalmartApiError("rate_limited");
  let json;
  try { json = JSON.parse(text); } catch { throw apiChanged(text); }
  if (!res.ok) throw apiChanged(text);
  return json;
}

export async function getItem(sku) { return parseProduct(await get(buildProductUrl(sku)), sku); }
export async function getStores(postalCode) { return parseStores(await get(buildStoresUrl(postalCode))); }

// One availability call; callers batch ids in chunks of LOCATIONS_PER_CALL.
// -> { aggregate, statuses, delivery } (delivery: ship-to-home for postalCode, see parseShipping).
export async function getAvailability(sku, locationIds, postalCode) {
  if (locationIds.length > LOCATIONS_PER_CALL) {
    throw new WalmartApiError("unknown", `getAvailability: at most ${LOCATIONS_PER_CALL} locations per call`);
  }
  const json = await get(buildAvailabilityUrl(sku, locationIds, postalCode));
  return { ...parseAvailability(json), delivery: parseShipping(json) };
}
