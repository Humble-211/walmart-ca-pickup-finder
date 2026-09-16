import { WalmartApiError, apiChanged } from "../../lib/errors.js";

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
  };
}

// Delivery nodes -> the Item.delivery summary. Walmart reports no count and no
// per-postal-code date for delivery, so only the status is real.
export function deliverySummary(stores) {
  const known = stores.filter((s) => s.status !== "unknown");
  const status = stores.some((s) => s.status === "available") ? "available" : known.length ? "out_of_stock" : "unknown";
  return { status, quantity: null, eta: null };
}
