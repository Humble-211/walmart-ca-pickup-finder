// Pure parsers for staples.ca responses. Field names: docs/staples-ca-endpoints.md §2-3
import { apiChanged } from "../../lib/errors.js";

const ORIGIN = "https://www.staples.ca";

// Shopify product .js JSON -> Item. `handle` is the item id the popup pasted.
export function parseProduct(json, handle) {
  if (!json || typeof json !== "object" || typeof json.title !== "string") throw apiChanged(JSON.stringify(json));
  const cents = Number(json.price);
  const image = typeof json.featured_image === "string" ? json.featured_image.replace(/^\/\//, "https://") : null;
  const tags = Array.isArray(json.tags) ? json.tags : [];
  return {
    id: String(handle),
    name: json.title,
    priceString: Number.isFinite(cents) ? `$${(cents / 100).toFixed(2)}` : "",
    imageUrl: image,
    url: typeof json.url === "string" && json.url.startsWith("/") ? ORIGIN + json.url : `${ORIGIN}/products/${handle}`,
    retailer: "staples",
    pickupEligible: !tags.includes("bopis_eligible:False"),
  };
}

// Inventory v2 response -> the (up to 5) nearest pickup stores for `sku`, nearest first.
// An empty map means unknown sku, not pickup-eligible, or no store within ~90 km.
export function parseAvailability(json, sku) {
  const all = json?.availability;
  if (!all || typeof all !== "object") throw apiChanged(JSON.stringify(json));
  const map = all[String(sku)] ?? {};
  return Object.entries(map)
    .map(([storeNumber, s]) => {
      const qty = Number(s?.availableqty);
      const d = Number.parseFloat(s?.distance);
      return {
        id: String(storeNumber),
        name: `Staples ${s?.city ?? ""}`.trim(),
        address: [s?.addressLine, [s?.city, [s?.state, s?.zipCode].filter(Boolean).join(" ")].filter(Boolean).join(", ")].filter(Boolean).join(", "),
        postalCode: String(s?.zipCode ?? ""),
        distanceKm: Number.isFinite(d) ? d : null,
        status: Number.isFinite(qty) ? (qty > 0 ? "available" : "out_of_stock") : "unknown",
        url: null,
      };
    })
    .sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity));
}
