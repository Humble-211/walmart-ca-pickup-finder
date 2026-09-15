// Pure parsers for bestbuy.ca responses. Field names: docs/bestbuy-ca-endpoints.md
import { WalmartApiError, apiChanged } from "../../lib/errors.js";

const ORIGIN = "https://www.bestbuy.ca";

// /api/v1/catalog/query response -> Item. total 0 / no items = unknown SKU.
export function parseProduct(json) {
  if (!json || typeof json !== "object" || !Array.isArray(json.items)) throw apiChanged(JSON.stringify(json));
  const p = json.items[0];
  if (!p) throw new WalmartApiError("not_found");
  if (!p.sku || !p.name) throw apiChanged(JSON.stringify(json));
  const price = p.salePrice ?? p.regularPrice;
  const path = typeof p.productUrl === "string" && p.productUrl.startsWith("/") ? p.productUrl.replace(/^\/en-CA\//, "/en-ca/") : `/en-ca/product/${p.sku}`;
  return {
    id: String(p.sku),
    name: String(p.name),
    priceString: typeof price === "number" && Number.isFinite(price) ? `$${price.toFixed(2)}` : "",
    imageUrl: p.thumbnailImage ? String(p.thumbnailImage) : null,
    url: ORIGIN + path,
    retailer: "bestbuy",
  };
}

// /api/v3/json/locations response -> stores with coordinates (no availability).
export function parseStores(json) {
  const list = json?.locations;
  if (!Array.isArray(list)) throw apiChanged(JSON.stringify(json));
  return list.map((s) => ({
    id: String(s.locationId ?? ""),
    name: String(s.name ?? ""),
    address: [s.address1, [s.city, [s.region, s.postalCode].filter(Boolean).join(" ")].filter(Boolean).join(", ")].filter(Boolean).join(", "),
    postalCode: String(s.postalCode ?? ""),
    lat: Number.isFinite(Number(s.lat)) ? Number(s.lat) : null,
    lon: Number.isFinite(Number(s.lng)) ? Number(s.lng) : null,
    distanceKm: Number.isFinite(Number(s.distance)) ? Number(s.distance) : null,
  }));
}

// /ecomm-api/availability/products response (one SKU) -> per-location statuses.
// hasInventory true -> available; false with supportsFulfillment -> out_of_stock; otherwise unknown.
// Locations the service does not carry are absent from the response: callers treat missing ids as unknown.
export function parseAvailability(json) {
  const a = json?.availabilities?.[0];
  if (!a || !a.pickup || !Array.isArray(a.pickup.locations)) throw apiChanged(JSON.stringify(json));
  const statuses = new Map();
  for (const l of a.pickup.locations) {
    const status = l.hasInventory === true ? "available" : l.supportsFulfillment === true ? "out_of_stock" : "unknown";
    statuses.set(String(l.locationKey), status);
  }
  return { aggregate: String(a.pickup.status ?? ""), statuses };
}
