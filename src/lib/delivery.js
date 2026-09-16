// Ship-to-home availability for the postal code the user typed, alongside the pickup search.
// Adapters attach it to the Item as `delivery`:
//   { status: "available" | "out_of_stock" | "unknown", quantity: number | null, eta: string | null,
//     seller?: string }
// `seller` is set only when someone other than the retailer ships the item (a marketplace
// offer), because that is what explains why no store of the retailer's own carries it.
// The eta is the retailer's own wording ("arrives Sep 22", "by Sep 16", "Estimated delivery in
// 1-3 business days"), so the popup never invents a promise the site did not make. An adapter
// that cannot answer for a postal code leaves `delivery` unset, and the line stays hidden.
const STATUS_LABEL = { available: "In stock", out_of_stock: "Out of stock", unknown: "Unknown" };

// "Delivery to M5V 3L9: In stock · 56 available · Estimated delivery in 1-3 business days"
export function deliveryText(delivery, postalCode) {
  if (!delivery) return "";
  const parts = [STATUS_LABEL[delivery.status] ?? STATUS_LABEL.unknown];
  if (delivery.status === "available" && Number.isFinite(delivery.quantity)) parts.push(`${delivery.quantity} available`);
  if (delivery.eta) parts.push(delivery.eta);
  if (delivery.seller) parts.push(`Ships from ${delivery.seller}`);
  return `Delivery to ${postalCode || "you"}: ${parts.join(" · ")}`;
}

// The status line for delivery mode when the retailer returns no per-store list: it has to
// carry the bad news on its own, because there is nothing else on screen to read.
export function deliveryModeStatus(item, postalCode) {
  if (!item) return "";
  const where = postalCode || "you";
  if (item.delivery?.status === "available") return "";
  if (item.delivery?.status === "out_of_stock") {
    // A marketplace offer is out of stock for everyone, so naming the postal code would
    // suggest the item ships elsewhere and only this address is the problem.
    return item.delivery.seller
      ? `${item.delivery.seller} has this out of stock.`
      : `This item cannot be delivered to ${where}.`;
  }
  return `This store did not say whether it delivers to ${where}.`;
}
