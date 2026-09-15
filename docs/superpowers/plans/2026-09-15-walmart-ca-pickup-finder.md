# Walmart.ca Pickup Finder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Chrome extension that, given one walmart.ca item ID (or product URL) and a Canadian postal code, lists nearby Walmart stores sorted by distance with per-store pickup stock status, and lets the user open the product page with a chosen store selected.

**Architecture:** Popup UI sends messages to a background service worker, which forwards them to a content script running in a walmart.ca tab. Only the content script talks to walmart.ca (two GraphQL persisted queries for lookup, one mutation to select a store), so requests carry the user's cookies and pass PerimeterX. Pure parsing/ranking logic lives in `src/lib/` and is unit-tested with real response fixtures.

**Tech Stack:** Chrome Manifest V3, plain JavaScript (ES modules), esbuild for bundling, vitest for unit tests, Node 24.

**Spec:** `docs/superpowers/specs/2026-09-15-walmart-ca-pickup-finder-design.md`
**Endpoint reference:** `docs/walmart-ca-endpoints.md` (hashes, headers, variable templates, response field paths)

## Global Constraints

- Chrome Manifest V3. `host_permissions: ["https://www.walmart.ca/*"]`, permissions `storage`, `tabs`.
- All walmart.ca requests are made from the content script with `credentials: "include"`. Popup and background never call walmart.ca.
- Required request headers on every walmart.ca call: `x-o-bu: WALMART-CA`, `x-o-mart: B2C`, `x-o-segment: oaoh`, `x-apollo-operation-name: <op>`, `content-type: application/json`.
- One product per lookup. No keyword search, no batch, no geolocation.
- Store list capped at 10 (`maxCount: 10`).
- Postal code validation: `^[A-Za-z]\d[A-Za-z]\s?\d[A-Za-z]\d$`; normalized to upper case with one space (`M1P 4P5`).
- Error copy (exact strings, shown in popup):
  - `Enter a walmart.ca item ID or product URL.`
  - `Enter a valid Canadian postal code (e.g. M5V 3L9).`
  - `Open walmart.ca in a tab and try again.`
  - `walmart.ca asked for verification. Complete it in the walmart.ca tab, then retry.`
  - `Postal code not recognized by Walmart.`
  - `Item not found.`
  - `Walmart changed its API: <first 200 chars of raw body>`
- Status labels in UI: `In stock`, `Out of stock`, `Unknown`.
- No TypeScript, no framework. Files stay small and single-purpose.
- Commit after every task with a conventional commit message ending in `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

## File structure

```
package.json                 scripts: test, build; devDeps: vitest, esbuild
build.mjs                    esbuild: bundles 3 entry points into dist/, copies static files
.gitignore                   + dist/
src/manifest.json            MV3 manifest (copied to dist/)
src/lib/errors.js            WalmartApiError(code, message, raw)
src/lib/parse-item-id.js     parseItemId(input) -> string|null
src/lib/postal-code.js       normalizePostalCode(input) -> string|null
src/lib/parse-walmart.js     parseStores(json) -> Store[], parseItem(json) -> Item
src/lib/rank-stores.js       rankStores(stores) -> Store[]
src/content/walmart-api.js   request builders + getItem/findStores/selectStore (uses fetch)
src/content/index.js         chrome.runtime.onMessage handler: ping, lookup, selectStore
src/background.js            message router; finds/opens walmart.ca tab; opens item tab
src/popup/popup.html         form + results markup
src/popup/popup.css          styling
src/popup/popup.js           form handling, storage, rendering, messaging
test/parse-item-id.test.js
test/postal-code.test.js
test/parse-walmart.test.js
test/rank-stores.test.js
test/walmart-api.test.js
test/fixtures/nearByNodes.json   (exists) real response, 5 stores, item 6000208927194
test/fixtures/itemById.json      (exists) real trimmed response, Bounty paper towel
README.md                    load-unpacked + re-discovery instructions
```

Message protocol (all via `chrome.runtime.sendMessage` / `chrome.tabs.sendMessage`, always answered with an object):

| Message | From → To | Response |
|---------|-----------|----------|
| `{type:"ping"}` | background → content | `{ok:true}` |
| `{type:"lookup", itemId, postalCode}` | popup → background → content | `{ok:true, item, stores}` or `{ok:false, code, error}` |
| `{type:"selectStore", store, postalCode, itemUrl}` | popup → background → content | `{ok:true}` or `{ok:false, code, error}`; background opens `itemUrl` in a new tab in both cases |

Error object shape everywhere: `{ok:false, code, error}` where `code` is one of `no_tab`, `verification`, `invalid_postal`, `not_found`, `api_changed`, `unknown` and `error` is the user-facing string.

---

### Task 1: Project scaffold + item ID parser

**Files:**
- Create: `package.json`, `src/lib/parse-item-id.js`, `test/parse-item-id.test.js`
- Modify: `.gitignore` (add `dist/`)

**Interfaces:**
- Produces: `parseItemId(input: string) -> string | null` (numeric ID string, or null)

- [ ] **Step 1: Create package.json and install dev dependencies**

```json
{
  "name": "walmart-ca-pickup-finder",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "build": "node build.mjs"
  },
  "devDependencies": {
    "esbuild": "^0.24.0",
    "vitest": "^2.1.0"
  }
}
```

Run: `npm install`
Expected: `node_modules/` created, no errors. Append `dist/` on its own line to `.gitignore`.

- [ ] **Step 2: Write the failing tests**

`test/parse-item-id.test.js`:

```js
import { describe, it, expect } from "vitest";
import { parseItemId } from "../src/lib/parse-item-id.js";

describe("parseItemId", () => {
  it("accepts a bare numeric id", () => {
    expect(parseItemId("6000208927194")).toBe("6000208927194");
  });
  it("trims whitespace around a bare id", () => {
    expect(parseItemId("  6000208927194\n")).toBe("6000208927194");
  });
  it("extracts id from an English product URL with slug", () => {
    expect(parseItemId("https://www.walmart.ca/en/ip/Bounty-Paper-Towel-8-Rolls/6000208927194")).toBe("6000208927194");
  });
  it("extracts id from a French product URL", () => {
    expect(parseItemId("https://www.walmart.ca/fr/ip/Bounty/6000208927194")).toBe("6000208927194");
  });
  it("extracts id from a URL without slug and with query string", () => {
    expect(parseItemId("https://www.walmart.ca/en/ip/6000208927194?athAsset=abc&athena=true")).toBe("6000208927194");
  });
  it("extracts id from a URL with trailing slash and hash", () => {
    expect(parseItemId("https://www.walmart.ca/en/ip/x/6000208927194/#reviews")).toBe("6000208927194");
  });
  it("returns null for empty input", () => {
    expect(parseItemId("")).toBeNull();
    expect(parseItemId("   ")).toBeNull();
  });
  it("returns null for junk", () => {
    expect(parseItemId("paper towels")).toBeNull();
    expect(parseItemId("https://www.walmart.ca/en/search?q=towel")).toBeNull();
  });
  it("returns null for too-short numbers", () => {
    expect(parseItemId("12345")).toBeNull();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/parse-item-id.test.js`
Expected: FAIL, "Failed to resolve import ../src/lib/parse-item-id.js"

- [ ] **Step 4: Implement parseItemId**

`src/lib/parse-item-id.js`:

```js
// Extracts a walmart.ca item ID from a bare ID or a product URL.
// walmart.ca product URLs look like /en/ip/<slug>/<id> or /en/ip/<id>.
const BARE_ID = /^\d{6,}$/;
const URL_ID = /\/ip\/(?:[^/?#]+\/)?(\d{6,})(?=[/?#]|$)/;

export function parseItemId(input) {
  const s = String(input ?? "").trim();
  if (!s) return null;
  if (BARE_ID.test(s)) return s;
  const m = s.match(URL_ID);
  return m ? m[1] : null;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/parse-item-id.test.js`
Expected: 9 passed

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json .gitignore src/lib/parse-item-id.js test/parse-item-id.test.js
git commit -m "feat: project scaffold and item id parser"
```

---

### Task 2: Postal code normalizer

**Files:**
- Create: `src/lib/postal-code.js`, `test/postal-code.test.js`

**Interfaces:**
- Produces: `normalizePostalCode(input: string) -> string | null` (`"M1P 4P5"` form, or null when invalid)

- [ ] **Step 1: Write the failing tests**

`test/postal-code.test.js`:

```js
import { describe, it, expect } from "vitest";
import { normalizePostalCode } from "../src/lib/postal-code.js";

describe("normalizePostalCode", () => {
  it("keeps a well-formed code", () => {
    expect(normalizePostalCode("M1P 4P5")).toBe("M1P 4P5");
  });
  it("uppercases and inserts the space", () => {
    expect(normalizePostalCode("m1p4p5")).toBe("M1P 4P5");
  });
  it("trims surrounding whitespace", () => {
    expect(normalizePostalCode("  m1p 4p5 ")).toBe("M1P 4P5");
  });
  it("rejects wrong shapes", () => {
    expect(normalizePostalCode("")).toBeNull();
    expect(normalizePostalCode("12345")).toBeNull();
    expect(normalizePostalCode("M1P4P")).toBeNull();
    expect(normalizePostalCode("M1P  4P5")).toBeNull();
    expect(normalizePostalCode("ZZZ 999")).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/postal-code.test.js`
Expected: FAIL, cannot resolve import

- [ ] **Step 3: Implement**

`src/lib/postal-code.js`:

```js
const POSTAL = /^([A-Za-z]\d[A-Za-z])\s?(\d[A-Za-z]\d)$/;

// Returns "A1A 1A1" form or null.
export function normalizePostalCode(input) {
  const m = String(input ?? "").trim().match(POSTAL);
  if (!m) return null;
  return `${m[1]} ${m[2]}`.toUpperCase();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/postal-code.test.js`
Expected: 4 passed

- [ ] **Step 5: Commit**

```bash
git add src/lib/postal-code.js test/postal-code.test.js
git commit -m "feat: postal code normalizer"
```

---

### Task 3: Error type and response parsers

**Files:**
- Create: `src/lib/errors.js`, `src/lib/parse-walmart.js`, `test/parse-walmart.test.js`
- Uses: `test/fixtures/nearByNodes.json`, `test/fixtures/itemById.json` (already present)

**Interfaces:**
- Produces:
  - `class WalmartApiError extends Error { code: string; raw: string; }` constructed as `new WalmartApiError(code, message, raw = "")`
  - `parseStores(json) -> Store[]` where `Store = { id, name, address, postalCode, distanceKm, status, accessPointId }`
  - `parseItem(json) -> Item` where `Item = { id, name, priceString, imageUrl, url, pickupEligible }`
  - `ERROR_MESSAGES` map `code -> user string`

- [ ] **Step 1: Write errors.js (no test needed beyond usage in parsers)**

`src/lib/errors.js`:

```js
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
```

- [ ] **Step 2: Write the failing parser tests**

`test/parse-walmart.test.js`:

```js
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseStores, parseItem } from "../src/lib/parse-walmart.js";
import { WalmartApiError } from "../src/lib/errors.js";

const nearBy = JSON.parse(readFileSync(new URL("./fixtures/nearByNodes.json", import.meta.url), "utf8"));
const item = JSON.parse(readFileSync(new URL("./fixtures/itemById.json", import.meta.url), "utf8"));

describe("parseStores", () => {
  it("maps every node in the fixture", () => {
    const stores = parseStores(nearBy);
    expect(stores).toHaveLength(5);
    expect(stores.map((s) => s.id)).toEqual(["3635", "1117", "3111", "3159", "1080"]);
  });

  it("maps fields of the first store", () => {
    const s = parseStores(nearBy)[0];
    expect(s).toEqual({
      id: "3635",
      name: "Scarborough Central",
      address: "300 Borough Dr, Scarborough, ON M1P 4P5",
      postalCode: "M1P 4P5",
      distanceKm: 0.07,
      status: "available",
      accessPointId: "86de1e9c-5357-4500-83d1-f0535de6c4c2",
    });
  });

  it("maps OUT_OF_STOCK to out_of_stock", () => {
    expect(parseStores(nearBy)[1].status).toBe("out_of_stock");
  });

  it("maps a missing product block to unknown", () => {
    const copy = structuredClone(nearBy);
    delete copy.data.nearByNodes.nodes[0].product;
    expect(parseStores(copy)[0].status).toBe("unknown");
  });

  it("prefers active PICKUP_INSTORE, falls back to PICKUP_CURBSIDE, else null", () => {
    const copy = structuredClone(nearBy);
    const node = copy.data.nearByNodes.nodes[0];
    node.capabilities = node.capabilities.filter((c) => c.accessPointType !== "PICKUP_INSTORE");
    expect(parseStores(copy)[0].accessPointId).toBe("7f3bbbcf-2bd5-413c-81af-5391c5084b1a");
    node.capabilities = node.capabilities.map((c) => ({ ...c, isActive: false }));
    expect(parseStores(copy)[0].accessPointId).toBeNull();
  });

  it("uses null distance when distance is not numeric", () => {
    const copy = structuredClone(nearBy);
    copy.data.nearByNodes.nodes[0].distance = null;
    expect(parseStores(copy)[0].distanceKm).toBeNull();
  });

  it("throws invalid_postal on INVALID_POSTAL_CODE", () => {
    const body = { data: { nearByNodes: null }, errors: [{ message: "INVALID_POSTAL_CODE" }] };
    expect(() => parseStores(body)).toThrow(WalmartApiError);
    try { parseStores(body); } catch (e) { expect(e.code).toBe("invalid_postal"); }
  });

  it("throws api_changed when nodes are missing", () => {
    try { parseStores({ data: {} }); throw new Error("no throw"); } catch (e) {
      expect(e).toBeInstanceOf(WalmartApiError);
      expect(e.code).toBe("api_changed");
      expect(e.message).toMatch(/^Walmart changed its API: /);
    }
  });
});

describe("parseItem", () => {
  it("maps the fixture product", () => {
    expect(parseItem(item)).toEqual({
      id: "6000208927194",
      name: "Bounty Paper Towel 8 Rolls (16 Regular Rolls Equivalent)",
      priceString: "$21.98",
      imageUrl: "https://i5.walmartimages.ca/asr/b7d197af-6dfa-4e8d-9b0d-299d1f914c4d.06c9ddf4c33575f5cb67360e68ce52fd.jpeg",
      url: "https://www.walmart.ca/en/ip/Bounty-Paper-Towel-8-Rolls-16-Regular-Rolls-Equivalent/6000208927194",
      pickupEligible: true,
    });
  });

  it("marks pickupEligible false when pickupOption.availabilityStatus is null", () => {
    const copy = structuredClone(item);
    copy.data.product.pickupOption.availabilityStatus = null;
    expect(parseItem(copy).pickupEligible).toBe(false);
  });

  it("falls back to /en/ip/<id> when canonicalUrl is missing and empty price when price is missing", () => {
    const copy = structuredClone(item);
    copy.data.product.canonicalUrl = null;
    copy.data.product.priceInfo = null;
    copy.data.product.imageInfo = null;
    const parsed = parseItem(copy);
    expect(parsed.url).toBe("https://www.walmart.ca/en/ip/6000208927194");
    expect(parsed.priceString).toBe("");
    expect(parsed.imageUrl).toBeNull();
  });

  it("throws not_found when product is null", () => {
    try { parseItem({ data: { product: null } }); throw new Error("no throw"); } catch (e) {
      expect(e.code).toBe("not_found");
    }
  });

  it("throws api_changed when the shape is wrong", () => {
    try { parseItem({ foo: 1 }); throw new Error("no throw"); } catch (e) {
      expect(e.code).toBe("api_changed");
    }
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/parse-walmart.test.js`
Expected: FAIL, cannot resolve `../src/lib/parse-walmart.js`

- [ ] **Step 4: Implement parsers**

`src/lib/parse-walmart.js`:

```js
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/parse-walmart.test.js`
Expected: 13 passed

- [ ] **Step 6: Commit**

```bash
git add src/lib/errors.js src/lib/parse-walmart.js test/parse-walmart.test.js
git commit -m "feat: walmart response parsers and error type"
```

---

### Task 4: Store ranking

**Files:**
- Create: `src/lib/rank-stores.js`, `test/rank-stores.test.js`

**Interfaces:**
- Consumes: `Store` from Task 3
- Produces: `rankStores(stores: Store[]) -> Store[]` (new array, ascending `distanceKm`, `null` distances last, stable)

- [ ] **Step 1: Write the failing test**

`test/rank-stores.test.js`:

```js
import { describe, it, expect } from "vitest";
import { rankStores } from "../src/lib/rank-stores.js";

const mk = (id, distanceKm) => ({ id, name: id, address: "", postalCode: "", distanceKm, status: "unknown", accessPointId: null });

describe("rankStores", () => {
  it("sorts by distance ascending", () => {
    const out = rankStores([mk("b", 5), mk("a", 1), mk("c", 3.2)]);
    expect(out.map((s) => s.id)).toEqual(["a", "c", "b"]);
  });
  it("puts null distances last and keeps their relative order", () => {
    const out = rankStores([mk("x", null), mk("a", 2), mk("y", null), mk("b", 1)]);
    expect(out.map((s) => s.id)).toEqual(["b", "a", "x", "y"]);
  });
  it("does not mutate the input", () => {
    const input = [mk("b", 2), mk("a", 1)];
    rankStores(input);
    expect(input.map((s) => s.id)).toEqual(["b", "a"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/rank-stores.test.js`
Expected: FAIL, cannot resolve import

- [ ] **Step 3: Implement**

`src/lib/rank-stores.js`:

```js
// Ascending by distance; unknown distances last. Array.prototype.sort is stable.
export function rankStores(stores) {
  const key = (s) => (s.distanceKm == null ? Number.POSITIVE_INFINITY : s.distanceKm);
  return [...stores].sort((a, b) => key(a) - key(b));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/rank-stores.test.js`
Expected: 3 passed

- [ ] **Step 5: Commit**

```bash
git add src/lib/rank-stores.js test/rank-stores.test.js
git commit -m "feat: rank stores by distance"
```

---

### Task 5: Walmart API client (request builders + fetch wrapper)

**Files:**
- Create: `src/content/walmart-api.js`, `test/walmart-api.test.js`
- Reference: `docs/walmart-ca-endpoints.md`

**Interfaces:**
- Consumes: `parseStores`, `parseItem` (Task 3), `WalmartApiError`, `apiChanged` (Task 3)
- Produces:
  - `buildHeaders(opName: string) -> object`
  - `buildNearByNodesUrl(postalCode: string, itemId: string, maxCount = 10) -> string`
  - `buildItemUrl(itemId: string) -> string`
  - `buildSetPickupBody(store: Store, postalCode: string) -> object`
  - `async getItem(itemId) -> Item`
  - `async findStores(postalCode, itemId, maxCount = 10) -> Store[]`
  - `async selectStore(store, postalCode) -> { storeId: string }`
  - All async functions use `globalThis.fetch` so tests can stub it.

- [ ] **Step 1: Write the failing tests**

`test/walmart-api.test.js`:

```js
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import {
  buildHeaders, buildNearByNodesUrl, buildItemUrl, buildSetPickupBody,
  getItem, findStores, selectStore,
} from "../src/content/walmart-api.js";

const nearBy = readFileSync(new URL("./fixtures/nearByNodes.json", import.meta.url), "utf8");
const item = readFileSync(new URL("./fixtures/itemById.json", import.meta.url), "utf8");

const jsonResponse = (body, status = 200) =>
  new Response(body, { status, headers: { "content-type": "application/json" } });

describe("request builders", () => {
  it("buildHeaders includes the required headers", () => {
    const h = buildHeaders("nearByNodes");
    expect(h["x-o-bu"]).toBe("WALMART-CA");
    expect(h["x-o-mart"]).toBe("B2C");
    expect(h["x-o-segment"]).toBe("oaoh");
    expect(h["x-apollo-operation-name"]).toBe("nearByNodes");
    expect(h["content-type"]).toBe("application/json");
  });

  it("buildNearByNodesUrl encodes the documented variables", () => {
    const url = new URL(buildNearByNodesUrl("M1P 4P5", "6000208927194", 10));
    expect(url.origin + url.pathname).toBe(
      "https://www.walmart.ca/orchestra/graphql/nearByNodes/d26e41479a06dc27775a042b88b74ea8b5b75d3a670bcafd080eb7a4e2bdf66f");
    const v = JSON.parse(url.searchParams.get("variables"));
    expect(v.input).toEqual({
      postalCode: "M1P 4P5",
      accessTypes: ["PICKUP_INSTORE", "PICKUP_CURBSIDE"],
      nodeTypes: ["STORE", "PICKUP_SPOKE", "PICKUP_POPUP"],
      latitude: null, longitude: null, radius: null,
      productId: "6000208927194",
      maxCount: 10,
    });
    expect(v.checkItemAvailability).toBe(true);
    for (const k of ["checkWeeklyReservation", "enableStoreSelectorMarketplacePickup", "enableVisionStoreSelector",
      "enableStorePagesAndFinderPhase2", "enableStoreBrandFormat", "disableNodeAddressPostalCode",
      "enableWICStoreSelector", "enableSparkStore"]) {
      expect(v[k]).toBe(false);
    }
  });

  it("buildItemUrl targets the ItemById hash and sets iId", () => {
    const url = new URL(buildItemUrl("6000208927194"));
    expect(url.pathname).toBe(
      "/orchestra/pdp/graphql/ItemById/dd90c309e2b4c9418dc5050720b5f8c8520e593aaf942fd2c7f6321ea820d500/ip/6000208927194");
    const v = JSON.parse(url.searchParams.get("variables"));
    expect(v.iId).toBe("6000208927194");
    expect(v.tenant).toBe("CA_GLASS");
    expect(v.fRev).toBe(false);
    expect(Object.keys(v)).toHaveLength(38);
  });

  it("buildSetPickupBody uses numeric storeId and the store accessPointId", () => {
    const body = buildSetPickupBody({ id: "3635", accessPointId: "86de1e9c-5357-4500-83d1-f0535de6c4c2" }, "M1P 4P5");
    expect(body).toEqual({
      variables: { input: {
        accessPointId: "86de1e9c-5357-4500-83d1-f0535de6c4c2",
        cartId: "00000000-0000-0000-0000-000000000000",
        postalCode: "M1P 4P5",
        storeId: 3635,
        enableLiquorBox: false,
        enableCartSplitClarity: true,
        features: ["lmpdel"],
      } },
    });
  });
});

describe("fetching", () => {
  let fetchMock;
  beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("findStores GETs with credentials and parses stores", async () => {
    fetchMock.mockResolvedValue(jsonResponse(nearBy));
    const stores = await findStores("M1P 4P5", "6000208927194");
    expect(stores).toHaveLength(5);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/orchestra/graphql/nearByNodes/");
    expect(init.credentials).toBe("include");
    expect(init.method ?? "GET").toBe("GET");
    expect(init.headers["x-apollo-operation-name"]).toBe("nearByNodes");
  });

  it("getItem parses the item", async () => {
    fetchMock.mockResolvedValue(jsonResponse(item));
    const parsed = await getItem("6000208927194");
    expect(parsed.name).toMatch(/^Bounty/);
    expect(fetchMock.mock.calls[0][1].headers["x-apollo-operation-name"]).toBe("ItemById");
  });

  it("selectStore POSTs the body and returns the store id from the response", async () => {
    fetchMock.mockResolvedValue(jsonResponse(JSON.stringify({
      data: { fulfillmentMutations: { setPickup: { fulfillment: { pickupStore: { storeId: "3635" } } } } },
    })));
    const out = await selectStore({ id: "3635", accessPointId: "abc" }, "M1P 4P5");
    expect(out).toEqual({ storeId: "3635" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/orchestra/graphql/setPickup/");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body).variables.input.storeId).toBe(3635);
  });

  it("selectStore throws api_changed when the response has no pickupStore", async () => {
    fetchMock.mockResolvedValue(jsonResponse(JSON.stringify({ data: { fulfillmentMutations: { setPickup: null } }, errors: [{ message: "Missing required header x-o-segment" }] })));
    await expect(selectStore({ id: "3635", accessPointId: "abc" }, "M1P 4P5")).rejects.toMatchObject({ code: "api_changed" });
  });

  it("maps HTTP 403 to verification", async () => {
    fetchMock.mockResolvedValue(new Response("<html>press and hold</html>", { status: 403, headers: { "content-type": "text/html" } }));
    await expect(findStores("M1P 4P5", "1")).rejects.toMatchObject({ code: "verification" });
  });

  it("maps HTTP 412 to verification", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 412 }));
    await expect(findStores("M1P 4P5", "1")).rejects.toMatchObject({ code: "verification" });
  });

  it("maps an HTML 200 body to verification", async () => {
    fetchMock.mockResolvedValue(new Response("<html>challenge</html>", { status: 200, headers: { "content-type": "text/html" } }));
    await expect(getItem("1")).rejects.toMatchObject({ code: "verification" });
  });

  it("maps HTTP 400 JSON to api_changed with the raw body", async () => {
    fetchMock.mockResolvedValue(jsonResponse('{"code":400,"message":"Something went wrong while processing the query."}', 400));
    await expect(findStores("M1P 4P5", "1")).rejects.toMatchObject({
      code: "api_changed",
      message: 'Walmart changed its API: {"code":400,"message":"Something went wrong while processing the query."}',
    });
  });

  it("propagates invalid_postal from the parser", async () => {
    fetchMock.mockResolvedValue(jsonResponse(JSON.stringify({ data: { nearByNodes: null }, errors: [{ message: "INVALID_POSTAL_CODE" }] })));
    await expect(findStores("ZZZ 999", "1")).rejects.toMatchObject({ code: "invalid_postal" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/walmart-api.test.js`
Expected: FAIL, cannot resolve `../src/content/walmart-api.js`

- [ ] **Step 3: Implement the client**

`src/content/walmart-api.js`:

```js
// Talks to walmart.ca internal GraphQL persisted queries. Must run inside a
// walmart.ca page so cookies and the PerimeterX clearance are sent.
// Endpoint details: docs/walmart-ca-endpoints.md
import { parseStores, parseItem } from "../lib/parse-walmart.js";
import { WalmartApiError, apiChanged } from "../lib/errors.js";

const ORIGIN = "https://www.walmart.ca";
const NEARBY_HASH = "d26e41479a06dc27775a042b88b74ea8b5b75d3a670bcafd080eb7a4e2bdf66f";
const ITEM_HASH = "dd90c309e2b4c9418dc5050720b5f8c8520e593aaf942fd2c7f6321ea820d500";
const SET_PICKUP_HASH = "6a6546328078a19211cd19fa5cc944c0ab3391debe1921175575027f42fcb726";

// Booleans the ItemById persisted query declares as Boolean! (all false = minimal payload).
const ITEM_FLAGS = ["fRev", "spSBA", "sVC", "enableImageClassification", "adV1Enabled", "eItIb", "fIlc",
  "enableDetailedBeacon", "fSeo", "fP13", "sV", "spVid", "fGalAd", "fMrkDscrp", "fSCar", "fBB", "eSb", "sIdml",
  "eLLBBAds", "fBBAd", "enableTopReasonsToBuy", "fFit", "fIdml", "fSL", "eCc", "fSId", "fMq", "eSsm", "fAff",
  "enableRelatedSearch", "fDac"];

export function buildHeaders(opName) {
  return {
    accept: "application/json",
    "content-type": "application/json",
    "x-o-platform": "rweb",
    "x-o-bu": "WALMART-CA",
    "x-o-mart": "B2C",
    "x-o-segment": "oaoh",
    "x-o-ccm": "server",
    wm_mp: "true",
    "x-apollo-operation-name": opName,
    "x-o-gql-query": `${opName === "setPickup" ? "mutation" : "query"} ${opName}`,
  };
}

export function buildNearByNodesUrl(postalCode, itemId, maxCount = 10) {
  const variables = {
    input: {
      postalCode,
      accessTypes: ["PICKUP_INSTORE", "PICKUP_CURBSIDE"],
      nodeTypes: ["STORE", "PICKUP_SPOKE", "PICKUP_POPUP"],
      latitude: null, longitude: null, radius: null,
      productId: String(itemId),
      maxCount,
    },
    checkItemAvailability: true,
    checkWeeklyReservation: false,
    enableStoreSelectorMarketplacePickup: false,
    enableVisionStoreSelector: false,
    enableStorePagesAndFinderPhase2: false,
    enableStoreBrandFormat: false,
    disableNodeAddressPostalCode: false,
    enableWICStoreSelector: false,
    enableSparkStore: false,
  };
  return `${ORIGIN}/orchestra/graphql/nearByNodes/${NEARBY_HASH}?variables=${encodeURIComponent(JSON.stringify(variables))}`;
}

export function buildItemUrl(itemId) {
  const variables = {
    iId: String(itemId), tenant: "CA_GLASS", channel: "WWW", version: "v1",
    pageType: "ItemPageGlobalDesktop", isMobile: false, postProcessingVersion: 1,
  };
  for (const k of ITEM_FLAGS) variables[k] = false;
  return `${ORIGIN}/orchestra/pdp/graphql/ItemById/${ITEM_HASH}/ip/${encodeURIComponent(String(itemId))}?variables=${encodeURIComponent(JSON.stringify(variables))}`;
}

export function buildSetPickupBody(store, postalCode) {
  return {
    variables: {
      input: {
        accessPointId: store.accessPointId,
        cartId: "00000000-0000-0000-0000-000000000000",
        postalCode,
        storeId: Number(store.id),
        enableLiquorBox: false,
        enableCartSplitClarity: true,
        features: ["lmpdel"],
      },
    },
  };
}

// Performs the request and returns parsed JSON, or throws WalmartApiError.
async function gql(url, opName, init = {}) {
  const res = await globalThis.fetch(url, { credentials: "include", ...init, headers: buildHeaders(opName) });
  const text = await res.text();
  const contentType = res.headers.get("content-type") ?? "";
  if (res.status === 403 || res.status === 412 || /text\/html/i.test(contentType) || /^\s*</.test(text)) {
    throw new WalmartApiError("verification");
  }
  let json;
  try { json = JSON.parse(text); } catch { throw apiChanged(text); }
  if (!res.ok) throw apiChanged(text);
  return json;
}

export async function getItem(itemId) {
  return parseItem(await gql(buildItemUrl(itemId), "ItemById"));
}

export async function findStores(postalCode, itemId, maxCount = 10) {
  return parseStores(await gql(buildNearByNodesUrl(postalCode, itemId, maxCount), "nearByNodes"));
}

export async function selectStore(store, postalCode) {
  const json = await gql(`${ORIGIN}/orchestra/graphql/setPickup/${SET_PICKUP_HASH}`, "setPickup", {
    method: "POST",
    body: JSON.stringify(buildSetPickupBody(store, postalCode)),
  });
  const storeId = json?.data?.fulfillmentMutations?.setPickup?.fulfillment?.pickupStore?.storeId;
  if (storeId == null) throw apiChanged(JSON.stringify(json));
  return { storeId: String(storeId) };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/walmart-api.test.js`
Expected: 13 passed

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: all files pass (parse-item-id 9, postal-code 4, parse-walmart 13, rank-stores 3, walmart-api 13)

- [ ] **Step 6: Commit**

```bash
git add src/content/walmart-api.js test/walmart-api.test.js
git commit -m "feat: walmart.ca api client with request builders"
```

---

### Task 6: Content script, background worker, manifest, build

**Files:**
- Create: `src/content/index.js`, `src/background.js`, `src/manifest.json`, `build.mjs`

**Interfaces:**
- Consumes: `getItem`, `findStores`, `selectStore` (Task 5); `rankStores` (Task 4); `toErrorResponse`, `WalmartApiError`, `ERROR_MESSAGES` (Task 3)
- Produces: the message protocol from the File structure section; `dist/` build output loadable as an unpacked extension.

- [ ] **Step 1: Write the content script**

`src/content/index.js`:

```js
// Runs on https://www.walmart.ca/*. Answers messages from the background worker.
import { getItem, findStores, selectStore } from "./walmart-api.js";
import { rankStores } from "../lib/rank-stores.js";
import { toErrorResponse } from "../lib/errors.js";

const MAX_STORES = 10;

async function handle(msg) {
  switch (msg?.type) {
    case "ping":
      return { ok: true };
    case "lookup": {
      const [item, stores] = await Promise.all([
        getItem(msg.itemId),
        findStores(msg.postalCode, msg.itemId, MAX_STORES),
      ]);
      return { ok: true, item, stores: rankStores(stores) };
    }
    case "selectStore": {
      const { storeId } = await selectStore(msg.store, msg.postalCode);
      return { ok: true, storeId };
    }
    default:
      return { ok: false, code: "unknown", error: `Unknown message type: ${msg?.type}` };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handle(msg).then(sendResponse, (err) => sendResponse(toErrorResponse(err)));
  return true; // keep the channel open for the async response
});
```

- [ ] **Step 2: Write the background worker**

`src/background.js`:

```js
// Routes popup messages to a content script in a walmart.ca tab.
import { ERROR_MESSAGES } from "./lib/errors.js";

const WALMART_URL = "https://www.walmart.ca/en";
const READY_TIMEOUT_MS = 15000;
const READY_POLL_MS = 500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ping(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: "ping" });
    return res?.ok === true;
  } catch {
    return false;
  }
}

// Returns a tab id whose content script answers ping, opening walmart.ca if needed.
async function getWalmartTab() {
  const tabs = await chrome.tabs.query({ url: "https://www.walmart.ca/*" });
  for (const t of tabs) if (await ping(t.id)) return t.id;
  const created = tabs[0] ?? (await chrome.tabs.create({ url: WALMART_URL, active: false }));
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await ping(created.id)) return created.id;
    await sleep(READY_POLL_MS);
  }
  return null;
}

async function forward(msg) {
  const tabId = await getWalmartTab();
  if (tabId == null) return { ok: false, code: "no_tab", error: ERROR_MESSAGES.no_tab };
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch (err) {
    return { ok: false, code: "no_tab", error: ERROR_MESSAGES.no_tab };
  }
}

async function handle(msg) {
  switch (msg?.type) {
    case "lookup":
      return forward(msg);
    case "selectStore": {
      const res = await forward(msg);
      if (msg.itemUrl) await chrome.tabs.create({ url: msg.itemUrl, active: true });
      return res;
    }
    default:
      return { ok: false, code: "unknown", error: `Unknown message type: ${msg?.type}` };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.tab) return false; // only the popup talks to the background
  handle(msg).then(sendResponse, (err) => sendResponse({ ok: false, code: "unknown", error: String(err?.message ?? err) }));
  return true;
});
```

- [ ] **Step 3: Write the manifest**

`src/manifest.json`:

```json
{
  "manifest_version": 3,
  "name": "Walmart.ca Pickup Finder",
  "version": "0.1.0",
  "description": "Find nearby Walmart Canada stores that have an item in stock for pickup.",
  "permissions": ["storage", "tabs"],
  "host_permissions": ["https://www.walmart.ca/*"],
  "background": { "service_worker": "background.js" },
  "action": { "default_popup": "popup/popup.html", "default_title": "Walmart.ca Pickup Finder" },
  "content_scripts": [
    { "matches": ["https://www.walmart.ca/*"], "js": ["content.js"], "run_at": "document_idle" }
  ]
}
```

- [ ] **Step 4: Write the build script**

`build.mjs`:

```js
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist/popup", { recursive: true });

await build({
  entryPoints: {
    "content": "src/content/index.js",
    "background": "src/background.js",
    "popup/popup": "src/popup/popup.js",
  },
  bundle: true,
  format: "iife",
  target: "chrome120",
  outdir: "dist",
  sourcemap: false,
  logLevel: "info",
});

cpSync("src/manifest.json", "dist/manifest.json");
cpSync("src/popup/popup.html", "dist/popup/popup.html");
cpSync("src/popup/popup.css", "dist/popup/popup.css");
console.log("built dist/");
```

The popup files do not exist yet. Create placeholder `src/popup/popup.js` with the single line `// filled in Task 7`, `src/popup/popup.html` containing `<!doctype html><title>Walmart.ca Pickup Finder</title>`, and an empty `src/popup/popup.css` so the build runs. Task 7 replaces them.

- [ ] **Step 5: Build and verify output**

Run: `npm run build`
Expected: esbuild prints three outputs; `dist/` contains `manifest.json`, `content.js`, `background.js`, `popup/popup.html`, `popup/popup.js`, `popup/popup.css`.

Run: `node -e "JSON.parse(require('fs').readFileSync('dist/manifest.json','utf8')); console.log('manifest ok')"`
Expected: `manifest ok`

- [ ] **Step 6: Load in Chrome and check the content script answers ping**

1. Open `chrome://extensions`, enable Developer mode, "Load unpacked", choose `dist/`.
2. Open `https://www.walmart.ca/en` in a tab. Complete the "press and hold" check if shown.
3. On `chrome://extensions`, click the extension's "service worker" link to open its console and run:
   ```js
   chrome.tabs.query({url:"https://www.walmart.ca/*"}).then(([t]) => chrome.tabs.sendMessage(t.id, {type:"ping"})).then(console.log)
   ```
   Expected: `{ok: true}`
4. Run in the same console:
   ```js
   chrome.tabs.query({url:"https://www.walmart.ca/*"}).then(([t]) => chrome.tabs.sendMessage(t.id, {type:"lookup", itemId:"6000208927194", postalCode:"M1P 4P5"})).then(console.log)
   ```
   Expected: `{ok: true, item: {name: "Bounty Paper Towel …", …}, stores: [10 entries sorted by distanceKm]}`

If step 4 returns `{ok:false, code:"verification"}`, reload the walmart.ca tab, pass the challenge, retry.

- [ ] **Step 7: Commit**

```bash
git add src/content/index.js src/background.js src/manifest.json build.mjs src/popup
git commit -m "feat: content script, background router, manifest and esbuild build"
```

---

### Task 7: Popup UI, end-to-end check, README

**Files:**
- Replace: `src/popup/popup.html`, `src/popup/popup.css`, `src/popup/popup.js`
- Create: `README.md`

**Interfaces:**
- Consumes: `parseItemId` (Task 1), `normalizePostalCode` (Task 2), message protocol (Task 6), `Item` and `Store` shapes (Task 3).

- [ ] **Step 1: Write popup.html**

`src/popup/popup.html`:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Walmart.ca Pickup Finder</title>
  <link rel="stylesheet" href="popup.css">
</head>
<body>
  <form id="form" autocomplete="off">
    <label>Item ID or product URL
      <input id="item" type="text" placeholder="6000208927194 or https://www.walmart.ca/en/ip/..." required>
    </label>
    <label>Postal code
      <input id="postal" type="text" placeholder="M5V 3L9" maxlength="7" required>
    </label>
    <button id="submit" type="submit">Find pickup stores</button>
  </form>

  <p id="error" class="error" hidden></p>
  <p id="status" class="status" hidden></p>

  <section id="itemCard" class="item" hidden>
    <img id="itemImage" alt="">
    <div>
      <a id="itemName" target="_blank" rel="noopener"></a>
      <div id="itemPrice" class="price"></div>
      <div id="itemNotice" class="notice" hidden>This item is not offered for pickup.</div>
    </div>
  </section>

  <ol id="stores" class="stores"></ol>

  <template id="storeRow">
    <li class="store">
      <div class="store-main">
        <div class="store-name"></div>
        <div class="store-address"></div>
      </div>
      <div class="store-side">
        <span class="badge"></span>
        <span class="distance"></span>
        <button class="pickup" type="button">Order pickup</button>
      </div>
    </li>
  </template>

  <script src="popup.js"></script>
</body>
</html>
```

- [ ] **Step 2: Write popup.css**

`src/popup/popup.css`:

```css
:root { color-scheme: light; font: 13px/1.4 system-ui, sans-serif; }
body { width: 380px; margin: 0; padding: 12px; background: #fff; color: #111; }
form { display: grid; gap: 8px; }
label { display: grid; gap: 3px; font-weight: 600; }
input { font: inherit; padding: 6px 8px; border: 1px solid #bbb; border-radius: 4px; }
button { font: inherit; padding: 7px 10px; border: 0; border-radius: 4px; background: #0071dc; color: #fff; cursor: pointer; }
button:disabled { background: #9bbbe0; cursor: default; }
.error { color: #b00020; margin: 10px 0 0; white-space: pre-wrap; }
.status { color: #555; margin: 10px 0 0; }
.item { display: flex; gap: 10px; margin-top: 12px; padding: 8px; border: 1px solid #ddd; border-radius: 6px; }
.item img { width: 56px; height: 56px; object-fit: contain; }
.item a { font-weight: 600; color: #111; text-decoration: none; }
.price { color: #2a8a2a; font-weight: 600; }
.notice { color: #b00020; margin-top: 4px; }
.stores { list-style: none; margin: 10px 0 0; padding: 0; display: grid; gap: 6px; }
.store { display: flex; justify-content: space-between; gap: 8px; padding: 8px; border: 1px solid #ddd; border-radius: 6px; }
.store-name { font-weight: 600; }
.store-address { color: #555; }
.store-side { display: grid; gap: 4px; justify-items: end; align-content: start; min-width: 96px; }
.badge { padding: 1px 6px; border-radius: 10px; font-size: 12px; font-weight: 600; }
.badge.available { background: #dff5e1; color: #1b6e2a; }
.badge.out_of_stock { background: #fde3e3; color: #a11; }
.badge.unknown { background: #eee; color: #555; }
.distance { color: #555; font-size: 12px; }
.pickup { padding: 4px 8px; font-size: 12px; }
```

- [ ] **Step 3: Write popup.js**

`src/popup/popup.js`:

```js
import { parseItemId } from "../lib/parse-item-id.js";
import { normalizePostalCode } from "../lib/postal-code.js";

const $ = (id) => document.getElementById(id);
const STATUS_LABEL = { available: "In stock", out_of_stock: "Out of stock", unknown: "Unknown" };

const state = { item: null, postalCode: "" };

function showError(msg) { $("error").textContent = msg; $("error").hidden = !msg; }
function showStatus(msg) { $("status").textContent = msg; $("status").hidden = !msg; }

function renderItem(item) {
  $("itemCard").hidden = false;
  $("itemImage").src = item.imageUrl ?? "";
  $("itemImage").hidden = !item.imageUrl;
  $("itemName").textContent = item.name;
  $("itemName").href = item.url;
  $("itemPrice").textContent = item.priceString;
  $("itemNotice").hidden = item.pickupEligible;
}

function renderStores(stores) {
  const list = $("stores");
  list.replaceChildren();
  const tpl = $("storeRow");
  for (const s of stores) {
    const li = tpl.content.firstElementChild.cloneNode(true);
    li.querySelector(".store-name").textContent = s.name;
    li.querySelector(".store-address").textContent = s.address;
    const badge = li.querySelector(".badge");
    badge.textContent = STATUS_LABEL[s.status] ?? STATUS_LABEL.unknown;
    badge.classList.add(s.status);
    li.querySelector(".distance").textContent = s.distanceKm == null ? "" : `${s.distanceKm.toFixed(1)} km`;
    const btn = li.querySelector(".pickup");
    btn.disabled = !s.accessPointId;
    btn.addEventListener("click", () => orderPickup(s, btn));
    list.append(li);
  }
  if (!stores.length) showStatus("No pickup stores found near that postal code.");
}

async function orderPickup(store, btn) {
  btn.disabled = true;
  showError("");
  showStatus(`Selecting ${store.name}…`);
  const res = await chrome.runtime.sendMessage({
    type: "selectStore", store, postalCode: state.postalCode, itemUrl: state.item.url,
  });
  btn.disabled = false;
  if (res?.ok) showStatus(`Opened product page with ${store.name} selected.`);
  else { showStatus(""); showError(`${res?.error ?? "Failed to select store."} The product page was opened; pick the store there.`); }
}

async function lookup(itemId, postalCode) {
  $("submit").disabled = true;
  showError("");
  showStatus("Looking up…");
  $("itemCard").hidden = true;
  $("stores").replaceChildren();
  try {
    const res = await chrome.runtime.sendMessage({ type: "lookup", itemId, postalCode });
    if (!res?.ok) { showStatus(""); showError(res?.error ?? "Lookup failed."); return; }
    state.item = res.item;
    state.postalCode = postalCode;
    showStatus("");
    renderItem(res.item);
    renderStores(res.stores);
  } catch (err) {
    showStatus("");
    showError(String(err?.message ?? err));
  } finally {
    $("submit").disabled = false;
  }
}

$("form").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const itemId = parseItemId($("item").value);
  if (!itemId) { showError("Enter a walmart.ca item ID or product URL."); return; }
  const postalCode = normalizePostalCode($("postal").value);
  if (!postalCode) { showError("Enter a valid Canadian postal code (e.g. M5V 3L9)."); return; }
  $("postal").value = postalCode;
  chrome.storage.local.set({ postalCode });
  lookup(itemId, postalCode);
});

chrome.storage.local.get("postalCode").then(({ postalCode }) => {
  if (postalCode) $("postal").value = postalCode;
});
```

- [ ] **Step 4: Build and run the end-to-end check**

Run: `npm run build`
Expected: three bundles, no errors.

Manual check in Chrome (reload the unpacked extension on `chrome://extensions` first):

1. With no walmart.ca tab open: click the extension icon, enter `6000208927194` and `M1P 4P5`, submit. Expected: a walmart.ca tab opens in the background; within ~15 s the popup shows the Bounty item card with `$21.98` and 10 stores, `Scarborough Central 0.1 km` first with an `In stock` badge. If walmart.ca shows the "press and hold" challenge in the new tab, the popup shows the verification error; pass the challenge and submit again.
2. Paste a full URL `https://www.walmart.ca/en/ip/Bounty-Paper-Towel-8-Rolls-16-Regular-Rolls-Equivalent/6000208927194` instead of the ID. Expected: same result.
3. Enter postal code `m1p4p5`. Expected: field is rewritten to `M1P 4P5`, lookup works.
4. Enter `ZZZ 999`. Expected: inline error `Enter a valid Canadian postal code (e.g. M5V 3L9).` with no request.
5. Enter item ID `6000202193202` (ship-only Bento box). Expected: item card shows the red notice `This item is not offered for pickup.`; stores list shows `Unknown` badges.
6. Enter item ID `1234567890`. Expected: error `Item not found.`
7. Click "Order pickup" on `Scarborough Central`. Expected: status `Opened product page with Scarborough Central selected.` and a new tab with the product page whose pickup option shows that store.
8. Close the popup and reopen it. Expected: postal code field is prefilled with `M1P 4P5`.

Record any deviation in the commit message body; do not mark the task done until steps 1, 5, 6 and 7 behave as listed.

- [ ] **Step 5: Write README.md**

`README.md`:

```markdown
# Walmart.ca Pickup Finder

Chrome extension. Enter a walmart.ca item ID (or paste the product URL) and a
Canadian postal code; get the nearest Walmart stores with that item's pickup
stock status, and open the product page with a store selected.

## Build and load

```sh
npm install
npm test
npm run build      # writes dist/
```

Chrome → `chrome://extensions` → Developer mode → Load unpacked → choose `dist/`.

The extension needs a `https://www.walmart.ca` tab; it opens one if none exists.
If walmart.ca shows its "press and hold" bot check, complete it in that tab and
run the lookup again.

## How it works

Requests go through a content script inside the walmart.ca tab so they carry the
user's session. Endpoints, headers and variable templates are documented in
`docs/walmart-ca-endpoints.md`. Design: `docs/superpowers/specs/`.

## When Walmart changes its API

Persisted query hashes in `src/content/walmart-api.js` are tied to the site
build. If lookups start failing with "Walmart changed its API", re-capture:

```sh
# 1. start a throwaway Chrome with remote debugging
"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir=%TEMP%\walmart-capture-profile https://www.walmart.ca/en
# 2. record traffic while you use the store picker and a product page
node tools/capture.js
# 3. look for nearByNodes / ItemById / setPickup in walmart-capture.jsonl,
#    update the hashes and variable lists, then refresh test/fixtures/
```

`tools/eval.js "<js expression>"` runs JavaScript inside that tab, useful for
probing variables against the live endpoint.
```

- [ ] **Step 6: Run the full test suite one last time**

Run: `npm test`
Expected: 5 test files, 42 tests, all passed.

- [ ] **Step 7: Commit**

```bash
git add src/popup README.md
git commit -m "feat: popup UI with store list and order-pickup action"
```

---

## Self-review

**Spec coverage**
- Popup inputs, postal persistence: Task 7. Item ID / URL parsing: Task 1. Postal validation: Task 2.
- Background finds/opens tab, 15 s ready wait: Task 6.
- Content-script-only fetching, required headers, two-request lookup, `rankStores`: Tasks 5, 6, 4.
- Order pickup via `setPickup` then open product page: Tasks 5, 6, 7.
- Error table: input errors (Task 7), no_tab (Task 6), verification / invalid_postal / not_found / api_changed (Tasks 3, 5), unknown status still listed (Task 3), disabled button without accessPointId (Task 7), setPickup failure still opens tab (Tasks 6, 7).
- Tests listed in spec: parseItemId, parsers with fixtures, rankStores, request builders with mocked fetch — Tasks 1–5. Manual E2E — Task 7.
- Out of scope items untouched.

**Placeholder scan**: only the Task 6 popup placeholders, which are explicitly replaced in Task 7.

**Type consistency**: `Store` fields (`id, name, address, postalCode, distanceKm, status, accessPointId`) and `Item` fields (`id, name, priceString, imageUrl, url, pickupEligible`) are used identically in Tasks 3, 5, 6, 7. Message shapes match the protocol table. Error codes match `ERROR_MESSAGES` keys.
