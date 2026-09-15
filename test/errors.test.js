import { describe, it, expect } from "vitest";
import { formatError, ERROR_MESSAGES } from "../src/lib/errors.js";

describe("formatError", () => {
  it("substitutes {host} and {label} from the adapter", () => {
    const adapter = { host: "www.bestbuy.ca", label: "Best Buy" };
    expect(formatError(ERROR_MESSAGES.no_tab, adapter)).toBe("Open www.bestbuy.ca in a tab and try again.");
    expect(formatError(ERROR_MESSAGES.verification, adapter)).toBe(
      "www.bestbuy.ca asked for verification. Complete it in the www.bestbuy.ca tab, then retry."
    );
    expect(formatError(ERROR_MESSAGES.rate_limited, adapter)).toBe(
      "www.bestbuy.ca is rate-limiting requests. Wait a minute or two and try again."
    );
    expect(formatError(ERROR_MESSAGES.api_changed, adapter)).toBe("Best Buy changed its API");
    expect(formatError(ERROR_MESSAGES.invalid_postal, adapter)).toBe("Postal code not recognized by Best Buy.");
  });
  it("substitutes {stores} from an adapter-like object", () => {
    expect(formatError(ERROR_MESSAGES.unsupported, { stores: "Walmart, Best Buy" })).toBe(
      "This store is not supported yet. Paste a product URL from Walmart, Best Buy."
    );
  });
  it("falls back to generic wording for an unknown/missing adapter", () => {
    expect(formatError(ERROR_MESSAGES.no_tab, undefined)).toBe("Open the store site in a tab and try again.");
    expect(formatError(ERROR_MESSAGES.api_changed, null)).toBe("The store changed its API");
    expect(formatError(ERROR_MESSAGES.unsupported, {})).toBe("This store is not supported yet. Paste a product URL from a supported store.");
  });
  it("is a no-op on a message with no placeholders", () => {
    expect(formatError(ERROR_MESSAGES.not_found, { host: "x", label: "Y" })).toBe("Item not found.");
  });
});
