import { WalmartApiError, apiChanged } from "./errors.js";

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
    };
  });
}

// Raw ItemById JSON -> Item
export function parseItem(json) {
  if (!json || typeof json !== "object" || !("data" in json)) throw apiChanged(JSON.stringify(json));
  const p = json.data?.product;
  if (p === null) throw new WalmartApiError("not_found");
  if (!p || typeof p !== "object" || !p.name) throw apiChanged(JSON.stringify(json));
  const id = String(p.usItemId ?? p.id ?? "");
  return {
    id,
    name: String(p.name),
    priceString: String(p.priceInfo?.currentPrice?.priceString ?? ""),
    imageUrl: p.imageInfo?.thumbnailUrl ? String(p.imageInfo.thumbnailUrl) : null,
    url: "https://www.walmart.ca" + (p.canonicalUrl || `/en/ip/${id}`),
    pickupEligible: p.pickupOption?.availabilityStatus != null,
  };
}
