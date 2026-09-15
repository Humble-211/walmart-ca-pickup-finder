export const ERROR_MESSAGES = {
  no_tab: "Open walmart.ca in a tab and try again.",
  verification: "walmart.ca asked for verification. Complete it in the walmart.ca tab, then retry.",
  invalid_postal: "Postal code not recognized by Walmart.",
  not_found: "Item not found.",
  api_changed: "Walmart changed its API",
  unknown: "Something went wrong.",
};

export class WalmartApiError extends Error {
  constructor(code, message, raw = "") {
    super(message ?? ERROR_MESSAGES[code] ?? ERROR_MESSAGES.unknown);
    this.name = "WalmartApiError";
    this.code = code;
    this.raw = String(raw ?? "").slice(0, 200);
  }
}

// Builds the "Walmart changed its API: <raw>" message.
export function apiChanged(raw) {
  const snippet = String(raw ?? "").slice(0, 200);
  return new WalmartApiError("api_changed", `${ERROR_MESSAGES.api_changed}: ${snippet}`, snippet);
}

// Converts any thrown value into the {ok:false, code, error} wire shape.
export function toErrorResponse(err) {
  if (err instanceof WalmartApiError) return { ok: false, code: err.code, error: err.message };
  return { ok: false, code: "unknown", error: `${ERROR_MESSAGES.unknown} ${err?.message ?? err}`.trim() };
}
