import { WalmartApiError, apiChanged } from "../../lib/errors.js";
import { dateRange } from "../../lib/dates.js";

const STATUS = { IN_STOCK: "available", OUT_OF_STOCK: "out_of_stock" };

function hasGraphqlError(json, message) {
  return Array.isArray(json?.errors) && json.errors.some((e) => e?.message === message);
}

function pickAccessPointId(capabilities) {
  const list = Array.isArray(capabilities) ? capabilities.filter((c) => c && c.isActive !== false && c.accessPointId) : [];
  const byType = (t) => list.find((c) => c.accessPointType === t);
  const hit = byType("PICKUP_INSTORE") ?? byType("PICKUP_CURBSIDE");
  return hit ? String(hit.accessPointId) : null;
}

function formatAddress(a) {
  if (!a) return "";
  const cityLine = [a.city, [a.state, a.postalCode].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  return [a.addressLineOne, cityLine].filter(Boolean).join(", ");
}

// Raw nearByNodes JSON -> Store[]
export function parseStores(json) {
  if (hasGraphqlError(json, "INVALID_POSTAL_CODE")) throw new WalmartApiError("invalid_postal");
  if (json?.data?.nearByNodes == null && hasGraphqlError(json, "SERVICE_UNAVAILABLE")) return []; // no pickup node near that point
  const nodes = json?.data?.nearByNodes?.nodes;
  if (!Array.isArray(nodes)) throw apiChanged(JSON.stringify(json));
  return nodes.map((n) => {
    const d = Number.parseFloat(n?.distance);
    return {
      id: String(n?.id ?? ""),
      name: String(n?.displayName ?? n?.name ?? ""),
      address: formatAddress(n?.address),
      postalCode: String(n?.address?.postalCode ?? ""),
      distanceKm: Number.isFinite(d) ? d : null,
      status: STATUS[n?.product?.availabilityStatus] ?? "unknown",
      accessPointId: pickAccessPointId(n?.capabilities),
      url: null, // walmart rows use setPickup, not a per-store URL
    };
  });
}

// The product's own ship-to-home answer, which is about the offer rather than about any
// Walmart node: { status, quantity: null, eta } or null when the payload does not say.
// `shippingRestriction` is walmart's flag for an offer that will not ship to the destination.
//
// The product's own availabilityStatus is read first and on its own, because an out-of-stock
// offer comes back with every shippingOption field nulled (verified with the PS5 Pro,
// `1SZQHN3LOSE0`, sold by DealWiz: availabilityStatus OUT_OF_STOCK, shippingOption present
// but blank). Treating that blank as "no answer" would report Unknown for an item the site
// plainly calls out of stock.
function shippingSummary(p) {
  const outOfStock = { status: "out_of_stock", quantity: null, eta: null };
  if (p.availabilityStatus === "OUT_OF_STOCK" || p.shippingRestriction === true) return outOfStock;
  const status = p.shippingOption?.availabilityStatus;
  if (status == null) return null; // genuinely unanswered: the product is not out of stock and no shipping status came back
  if (status !== "AVAILABLE") return outOfStock;
  const when = dateRange(p.shippingOption?.deliveryDate, p.shippingOption?.maxDeliveryDate);
  return { status: "available", quantity: null, eta: when ? `arrives ${when}` : null };
}

// Raw ItemById JSON -> Item
export function parseItem(json) {
  if (!json || typeof json !== "object" || !("data" in json)) throw apiChanged(JSON.stringify(json));
  const p = json.data?.product;
  if (p === null) throw new WalmartApiError("not_found");
  if (!p || typeof p !== "object") throw apiChanged(JSON.stringify(json));
  if (!p.name && !p.usItemId) throw new WalmartApiError("not_found"); // live API returns an empty shell for unknown ids
  if (!p.name) throw apiChanged(JSON.stringify(json));
  const id = String(p.usItemId ?? p.id ?? "");
  const path = typeof p.canonicalUrl === "string" && /^\/(?!\/)/.test(p.canonicalUrl) ? p.canonicalUrl : `/en/ip/${id}`;
  return {
    id,
    retailer: "walmart",
    name: String(p.name),
    priceString: String(p.priceInfo?.currentPrice?.priceString ?? ""),
    imageUrl: p.imageInfo?.thumbnailUrl ? String(p.imageInfo.thumbnailUrl) : null,
    url: "https://www.walmart.ca" + path,
    pickupEligible: p.pickupOption?.availabilityStatus != null,
    // A marketplace offer: sold by someone other than Walmart, so no Walmart node stocks it.
    soldByThirdParty: p.offerType === "3P" || p.sellerType === "EXTERNAL",
    sellerName: p.sellerName ? String(p.sellerName) : null,
    shipping: shippingSummary(p),
  };
}

// Delivery nodes -> the Item.delivery summary. Walmart reports no count and no
// per-postal-code date for delivery, so for its own items only the status is real.
//
// A third-party offer is the exception, and the reason this takes the item at all. The nodes
// are Walmart's own stores and warehouses; they never hold a marketplace seller's inventory,
// so every node answers OUT_OF_STOCK even for an item the seller ships across the country
// (verified against walmart.ca: a 3P offer reports OUT_OF_STOCK at all 10 nodes near L4K 0P8
// while the product itself is IN_STOCK with shipping AVAILABLE). Rolling those nodes up would
// tell the user an item that ships today cannot be delivered, so for such an offer the
// product's own shipping answer is the only one worth reporting.
export function deliverySummary(stores, item = null) {
  if (item?.soldByThirdParty) {
    const shipping = item.shipping ?? { status: "unknown", quantity: null, eta: null };
    return item.sellerName ? { ...shipping, seller: item.sellerName } : shipping;
  }
  const known = stores.filter((s) => s.status !== "unknown");
  const status = stores.some((s) => s.status === "available") ? "available" : known.length ? "out_of_stock" : "unknown";
  return { status, quantity: null, eta: null };
}
