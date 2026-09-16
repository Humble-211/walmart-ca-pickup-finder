// Pure parsers for shoppersdrugmart.ca responses. Field names: docs/shoppers-ca-endpoints.md §2-3
import { apiChanged } from "../../lib/errors.js";

const ORIGIN = "https://www.shoppersdrugmart.ca";

// variantProduct details -> Item. `code` is the variant code the popup pasted.
export function parseProduct(json, code) {
  if (!json || typeof json !== "object" || typeof json.name !== "string") throw apiChanged(JSON.stringify(json));
  const price = json.effectivePrice ?? json.specialPrice ?? json.price;
  const image = [...(Array.isArray(json.images) ? json.images : [])].sort((a, b) => imageSize(b) - imageSize(a))[0]?.url;
  const path = typeof json.url === "string" && json.url.startsWith("/") ? json.url : null;
  return {
    id: String(code),
    name: [json.brandName, json.name].filter((s) => typeof s === "string" && s.trim()).join(" "),
    priceString: typeof price?.formattedValue === "string" ? price.formattedValue : Number.isFinite(price?.value) ? `$${price.value.toFixed(2)}` : "",
    imageUrl: typeof image === "string" ? image : null,
    url: typeof json.canonicalUrl === "string" && json.canonicalUrl.startsWith("https://") ? json.canonicalUrl : path ? ORIGIN + path : `${ORIGIN}/p/BB_${code}`,
    retailer: "shoppers",
    pickupEligible: json.bopisIneligible !== true,
  };
}

// Prefer the mid-size gallery image (the "size…" format names carry the pixel width).
function imageSize(img) {
  const m = String(img?.format ?? "").match(/(\d+)/);
  const n = m ? Number(m[1]) : 0;
  return n > 0 && n <= 400 ? n : n > 400 ? 1 : 0; // 100..400 preferred over huge ones
}

// store-locator/store-details -> the (up to 10) nearest stores, nearest first. `distanceKm`
// is measured from the coordinates sent in the request. A 204 (no store within ~20 km)
// reaches this as null/empty and yields []. The endpoint reports quantity 0 for stores
// that do not carry the product and for unknown products alike, so an unknown product
// has to be caught by the product endpoint, not here.
export function parseStoreDetails(json) {
  if (json == null || json === "") return [];
  const inv = json?.storeInventory;
  if (!Array.isArray(inv)) throw apiChanged(JSON.stringify(json));
  return inv
    .map((row) => {
      const s = row?.store ?? {}, a = s.storeAddress ?? {};
      const qty = Number(row?.quantity), d = Number(s.distance);
      const id = String(s.storeId ?? a.id ?? "");
      return {
        id,
        name: typeof a.name === "string" && a.name.trim() ? a.name.trim() : `Shoppers Drug Mart ${id}`,
        address: [a.line1, [a.town, [a.province, a.postalCode].filter(Boolean).join(" ")].filter(Boolean).join(", ")].filter(Boolean).join(", "),
        postalCode: String(a.postalCode ?? ""),
        distanceKm: Number.isFinite(d) ? d : null,
        status: Number.isFinite(qty) ? (qty > 0 ? "available" : "out_of_stock") : "unknown",
        url: null,
      };
    })
    .filter((s) => s.id)
    .sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity));
}

// fulfillment-options response -> ship-to-home for the postal code sent. Status strings seen:
// "AVAILABLE", "POSTAL_CODE_NOT_SET"; anything with OUT_OF_STOCK / UNAVAILABLE counts as out of stock.
export function parseDelivery(json) {
  const s = json?.fulfillment?.shipping;
  if (!s || typeof s !== "object") throw apiChanged(JSON.stringify(json));
  const status = String(s.status ?? "");
  const qty = Number(s.quantity);
  return {
    status: status === "AVAILABLE" ? "available" : /OUT_OF_STOCK|UNAVAILABLE|NOT_AVAILABLE/i.test(status) ? "out_of_stock" : "unknown",
    quantity: Number.isFinite(qty) ? qty : null,
    eta: typeof s.estimatedDeliveryTime === "string" && s.estimatedDeliveryTime.trim() ? s.estimatedDeliveryTime.trim() : null,
  };
}
