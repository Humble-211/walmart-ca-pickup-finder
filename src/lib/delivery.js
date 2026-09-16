// Ship-to-home availability for the postal code the user typed, alongside the pickup search.
// Adapters attach it to the Item as `delivery`:
//   { status: "available" | "out_of_stock" | "unknown", quantity: number | null, eta: string | null }
// The eta is the retailer's own wording ("arrives Sep 22", "by Sep 16", "Estimated delivery in
// 1-3 business days"), so the popup never invents a promise the site did not make. Adapters that
// cannot answer for a postal code (walmart: delivery follows the session's chosen store) leave it
// unset, and the line stays hidden.
const STATUS_LABEL = { available: "In stock", out_of_stock: "Out of stock", unknown: "Unknown" };

// "Delivery to M5V 3L9: In stock · 56 available · Estimated delivery in 1-3 business days"
export function deliveryText(delivery, postalCode) {
  if (!delivery) return "";
  const parts = [STATUS_LABEL[delivery.status] ?? STATUS_LABEL.unknown];
  if (delivery.status === "available" && Number.isFinite(delivery.quantity)) parts.push(`${delivery.quantity} available`);
  if (delivery.eta) parts.push(delivery.eta);
  return `Delivery to ${postalCode || "you"}: ${parts.join(" · ")}`;
}

// The status line for delivery mode when the retailer returns no per-store list: it has to
// carry the bad news on its own, because there is nothing else on screen to read.
export function deliveryModeStatus(item, postalCode) {
  if (!item) return "";
  const where = postalCode || "you";
  if (item.delivery?.status === "available") return "";
  if (item.delivery?.status === "out_of_stock") return `This item cannot be delivered to ${where}.`;
  return `This store did not say whether it delivers to ${where}.`;
}
