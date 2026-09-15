// Retailer-neutral message templates. `{host}` / `{label}` / `{stores}` are
// substituted by `formatError` once the caller knows which adapter raised
// the error (background.js and the retailer api.js/parse.js modules throw
// these un-substituted; the popup fills them in for display).
export const ERROR_MESSAGES = {
  no_tab: "Open {host} in a tab and try again.",
  verification: "{host} asked for verification. Complete it in the {host} tab, then retry.",
  invalid_postal: "Postal code not recognized by {label}.",
  not_found: "Item not found.",
  api_changed: "{label} changed its API",
  rate_limited: "{host} is rate-limiting requests. Wait a minute or two and try again.",
  unknown: "Something went wrong.",
  unsupported: "This store is not supported yet. Paste a product URL from {stores}.",
};

export class WalmartApiError extends Error {
  constructor(code, message, raw = "") {
    super(message ?? ERROR_MESSAGES[code] ?? ERROR_MESSAGES.unknown);
    this.name = "WalmartApiError";
    this.code = code;
    this.raw = String(raw ?? "").slice(0, 200);
  }
}

// Builds the "{label} changed its API: <raw>" message (placeholder left for formatError).
export function apiChanged(raw) {
  const snippet = String(raw ?? "").slice(0, 200);
  return new WalmartApiError("api_changed", `${ERROR_MESSAGES.api_changed}: ${snippet}`, snippet);
}

// Substitutes {host}/{label}/{stores} placeholders in a message using an adapter
// (any object with host/label/stores fields, e.g. RETAILERS[retailer]). Falls
// back to generic wording when adapter is missing or lacks a field.
export function formatError(message, adapter) {
  const host = adapter?.host ?? "the store site";
  const label = adapter?.label ?? "The store";
  const stores = adapter?.stores ?? "a supported store";
  return String(message ?? "")
    .replaceAll("{host}", host)
    .replaceAll("{label}", label)
    .replaceAll("{stores}", stores);
}

// Converts any thrown value into the {ok:false, code, error} wire shape.
export function toErrorResponse(err) {
  if (err instanceof WalmartApiError) return { ok: false, code: err.code, error: err.message };
  return { ok: false, code: "unknown", error: `${ERROR_MESSAGES.unknown} ${err?.message ?? err}`.trim() };
}
