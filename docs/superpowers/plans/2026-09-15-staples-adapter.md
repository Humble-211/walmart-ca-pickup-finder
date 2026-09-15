# Staples Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add staples.ca as the third retailer adapter: paste a staples.ca product URL + postal code, see the 5 nearest Staples stores with live pickup stock, then probe outward across Canada for the nearest store that has the item.

**Architecture:** Same adapter framework as walmart/bestbuy (`src/retailers/staples/{urls.js,parse.js,api.js,content.js,stores-ca.json}` + registry + manifest entry). Staples' availability endpoint returns only the 5 nearest pickup stores within ~90 km of a postal code and accepts no store list, so the nationwide search reuses walmart's outward prober `src/lib/stock-search.js`, generalised to take the probe shape (`maxCount`, `radiusKm`, store-centred only) and to hand the probe centre to `fetchAround` so Staples can seed each call with that store's postal code. A build-time tool pulls the 302-store list from Staples' public Algolia `store_locations` index.

**Tech Stack:** Chrome MV3, ES modules, esbuild, vitest 2, Node 24+.

**Spec:** `docs/superpowers/specs/2026-09-15-multi-retailer-design.md` (framework, binding) + `docs/staples-ca-endpoints.md` (endpoint facts, authoritative for field names, limits and errors).

## Global Constraints

- Shared shapes: `Item { id, name, priceString, imageUrl, url, retailer, pickupEligible }`, `Store { id, name, address, postalCode, distanceKm|null, status: "available"|"out_of_stock"|"unknown", url }`, `SearchResult { inStock, searched, checkedIds, complete, rateLimited, noLocation? }`.
- Error codes: `no_tab`, `verification`, `invalid_postal`, `not_found`, `api_changed`, `rate_limited`, `unsupported`, `unknown` (messages are `{host}`/`{label}` templates formatted by the popup).
- Every retailer call runs inside the retailer's content script; Staples calls use `credentials: "omit"` (the availability endpoint's CORS preflight rejects credentialed requests).
- Staples item id = the Shopify **handle** (`<sku>-en-<slug>`); the numeric SKU is the leading digits. The slug is load-bearing: product requests need the full handle.
- Availability: POST `https://api.staples.ca/ecommerce/inventory/v2.0/request` with `{ locale: "en-CA", postal_code, items: [{ sku, quantity: 1000 }], location: "PickInStore" }`; returns the 5 nearest pickup stores within ~90 km; `availableqty > 0` -> available, `=== 0` -> out_of_stock, absent -> unknown. Empty map for unknown SKU, `bopis_eligible:False` items and no store in range.
- Nationwide search: outward probing, 5 stores per call, ~90 km reach, max 40 calls per click, 1 s apart; "Keep searching farther" continues from `checkedIds`.
- No Algolia calls at runtime (build-time store list only); no new host permissions beyond `https://www.staples.ca/*` and `https://api.staples.ca/*`.
- Tests: `npx vitest run`; build: `npm run build`. New files LF; run `sed -i 's/\r$//' <file>` before multi-line edits of CRLF files.
- Commit after every task with the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`; do not push.

---

## File structure

```
src/retailers/staples/
  urls.js          id "staples", label "Staples", host www.staples.ca, homeUrl https://www.staples.ca/, parseProductUrl -> handle, skuFromHandle
  parse.js         parseProduct(json, handle) -> Item; parseAvailability(json, sku) -> Store[] (5 nearest, with distanceKm)
  api.js           getItem(handle), getAvailability(sku, postalCode) -> Store[]
  content.js       ping / lookup / findInStock / selectStore(unsupported)
  stores-ca.json   { generatedAt, stores: [{ id, name, address, postalCode, lat, lon }] }  (302 stores)
src/lib/stock-search.js   + probe options { maxCount, radiusKm, centroids }; fetchAround(lat, lon, centre)
tools/build-staples-stores.mjs
test/staples-urls.test.js, staples-parse.test.js, staples-api.test.js, staples-search.test.js; stock-search.test.js (+ option tests)
```

---

### Task 1: Staples URL adapter and registry entry

**Files:**
- Create: `src/retailers/staples/urls.js`, `test/staples-urls.test.js`
- Modify: `src/retailers/index.js`, `test/retailers.test.js`

**Interfaces:**
- Produces: `{ id: "staples", label: "Staples", host: "www.staples.ca", homeUrl: "https://www.staples.ca/", parseProductUrl(input) -> handle|null, skuFromHandle(handle) -> string|null }`.

- [ ] **Step 1: Failing tests**

`test/staples-urls.test.js`:

```js
import { describe, it, expect } from "vitest";
import { parseProductUrl, skuFromHandle } from "../src/retailers/staples/urls.js";

const HANDLE = "3082604-en-brother-hl-l2405w-home-office-ready-monochrome-laser-printer";

describe("staples parseProductUrl", () => {
  it("returns the full handle from an English product URL", () => {
    expect(parseProductUrl(`https://www.staples.ca/products/${HANDLE}`)).toBe(HANDLE);
  });
  it("accepts the /fr/ locale prefix and strips query strings and hashes", () => {
    expect(parseProductUrl(`https://www.staples.ca/fr/products/${HANDLE}?trk=product_clicked_trk_39723906269313#x`)).toBe(HANDLE);
  });
  it("accepts 5- and 8-digit skus", () => {
    expect(parseProductUrl("https://www.staples.ca/products/14336-en-staples-copy-paper")).toBe("14336-en-staples-copy-paper");
    expect(parseProductUrl("https://www.staples.ca/products/24501714-en-canon-pixma-tr4720")).toBe("24501714-en-canon-pixma-tr4720");
  });
  it("rejects bare ids, handles without a sku prefix, and other hosts", () => {
    expect(parseProductUrl("3082604")).toBeNull();
    expect(parseProductUrl("https://www.staples.ca/products/brother-printer")).toBeNull();
    expect(parseProductUrl("https://www.bestbuy.ca/en-ca/product/x/19446111")).toBeNull();
    expect(parseProductUrl("https://www.staples.ca/collections/printers")).toBeNull();
  });
});

describe("skuFromHandle", () => {
  it("returns the leading digits", () => {
    expect(skuFromHandle(HANDLE)).toBe("3082604");
    expect(skuFromHandle("14336-en-x")).toBe("14336");
  });
  it("returns null when the handle has no numeric prefix", () => {
    expect(skuFromHandle("brother-printer")).toBeNull();
    expect(skuFromHandle("")).toBeNull();
  });
});
```

Add to `test/retailers.test.js`:

```js
  it("routes a staples.ca product URL to the staples adapter with the handle as item id", () => {
    expect(parseProductUrl("https://www.staples.ca/products/3082604-en-brother-hl-l2405w-printer"))
      .toEqual({ retailer: "staples", itemId: "3082604-en-brother-hl-l2405w-printer" });
  });
```

- [ ] **Step 2: Run** `npx vitest run test/staples-urls.test.js test/retailers.test.js` -> FAIL (module missing).

- [ ] **Step 3: Implement**

`src/retailers/staples/urls.js`:

```js
// staples.ca product URLs: /products/<handle> or /fr/products/<handle>, where the
// Shopify handle is "<sku>-<lang>-<slug>" and the sku is the leading digits (5-8 seen).
// The slug is load-bearing (the product endpoint needs the full handle), so the
// item id IS the handle. Docs: docs/staples-ca-endpoints.md §1
const URL_HANDLE = /^https?:\/\/(?:www\.)?staples\.ca\/(?:fr\/)?products\/(\d{4,10}-[a-z]{2}-[a-z0-9-]+)(?=[/?#]|$)/i;
const HANDLE_SKU = /^(\d{4,10})-/;

export const id = "staples";
export const label = "Staples";
export const host = "www.staples.ca";
export const homeUrl = "https://www.staples.ca/";

export function parseProductUrl(input) {
  const m = String(input ?? "").trim().match(URL_HANDLE);
  return m ? m[1] : null;
}

export function skuFromHandle(handle) {
  const m = String(handle ?? "").match(HANDLE_SKU);
  return m ? m[1] : null;
}
```

Register in `src/retailers/index.js`: `import * as staples from "./staples/urls.js";` and add `staples` to the `RETAILERS` array before `walmart` (walmart stays last).

- [ ] **Step 4: Run** `npx vitest run` -> pass. Commit: `git add src/retailers/staples/urls.js src/retailers/index.js test/staples-urls.test.js test/retailers.test.js && git commit -m "feat: staples url adapter"`.

---

### Task 2: Staples parsers

**Files:**
- Create: `src/retailers/staples/parse.js`, `test/staples-parse.test.js`

**Interfaces:**
- Consumes: fixtures `test/fixtures/staples-product.json` (Shopify product `.js` JSON: `title`, `price` in cents, `featured_image` protocol-relative, `url`, `tags[]`, `variants[0].sku`) and `test/fixtures/staples-availability.json` (`{ success, availability: { "<sku>": { "<storeNumber>": { addressLine, city, state, zipCode, distance (string km), availableqty, ... } } } }`).
- Produces: `parseProduct(json, handle) -> Item` (`id` = handle, `pickupEligible` = tags do not contain `bopis_eligible:False`), `parseAvailability(json, sku) -> Store[]` sorted by distance, `status` from `availableqty`, `url` left `null` (content script fills the item URL).

- [ ] **Step 1: Failing tests**

`test/staples-parse.test.js`:

```js
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseProduct, parseAvailability } from "../src/retailers/staples/parse.js";

const load = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8"));
const product = load("staples-product.json");
const availability = load("staples-availability.json");
const HANDLE = product.handle;
const SKU = product.variants[0].sku;

describe("staples parseProduct", () => {
  it("maps title, cents price, https image, canonical url, retailer and pickup eligibility", () => {
    const item = parseProduct(product, HANDLE);
    expect(item).toMatchObject({ id: HANDLE, name: product.title, retailer: "staples", url: "https://www.staples.ca" + product.url });
    expect(item.priceString).toBe(`$${(product.price / 100).toFixed(2)}`);
    expect(item.imageUrl).toMatch(/^https:\/\/cdn\.shopify\.com\//);
    expect(item.pickupEligible).toBe(!product.tags.includes("bopis_eligible:False"));
  });
  it("marks bopis_eligible:False items as not pickup eligible", () => {
    const item = parseProduct({ ...product, tags: ["bopis_eligible:False"] }, HANDLE);
    expect(item.pickupEligible).toBe(false);
  });
  it("throws api_changed on an unexpected shape", () => {
    expect(() => parseProduct({ foo: 1 }, HANDLE)).toThrow(expect.objectContaining({ code: "api_changed" }));
  });
});

describe("staples parseAvailability", () => {
  it("returns the stores for the sku, nearest first, with quantity mapped to status", () => {
    const stores = parseAvailability(availability, SKU);
    expect(stores.length).toBeGreaterThan(0);
    const raw = availability.availability[SKU];
    for (const s of stores) {
      const r = raw[s.id];
      expect(r).toBeDefined();
      expect(s.status).toBe(r.availableqty > 0 ? "available" : "out_of_stock");
      expect(s.distanceKm).toBeCloseTo(Number(r.distance), 5);
      expect(s.address).toContain(r.city);
      expect(s.postalCode).toBe(r.zipCode);
      expect(s.url).toBeNull();
    }
    for (let i = 1; i < stores.length; i++) expect(stores[i].distanceKm).toBeGreaterThanOrEqual(stores[i - 1].distanceKm);
  });
  it("returns an empty list for the empty map (unknown sku / not eligible / no store in range)", () => {
    expect(parseAvailability({ success: true, availability: { [SKU]: {} } }, SKU)).toEqual([]);
    expect(parseAvailability({ success: true, availability: {} }, SKU)).toEqual([]);
  });
  it("throws api_changed when the availability object is missing", () => {
    expect(() => parseAvailability({ success: false }, SKU)).toThrow(expect.objectContaining({ code: "api_changed" }));
  });
});
```

- [ ] **Step 2: Run** `npx vitest run test/staples-parse.test.js` -> FAIL.

- [ ] **Step 3: Implement**

`src/retailers/staples/parse.js`:

```js
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
```

- [ ] **Step 4: Run** `npx vitest run` -> pass. Commit: `git add src/retailers/staples/parse.js test/staples-parse.test.js && git commit -m "feat: staples parsers"`.

---

### Task 3: Generalise the outward prober for small, store-seeded probes

**Files:**
- Modify: `src/lib/stock-search.js`, `test/stock-search.test.js`
- Verify unchanged behaviour: `src/retailers/walmart/content.js` (no edit needed)

**Interfaces:**
- Produces: `findNearestInStock({ nearby, user, catalog, fetchAround, onProgress, maxCalls = 20, gapMs = 0, probe = {} })` where `probe = { maxCount = 50, radiusKm = 100, centroids = true }`; `fetchAround(lat, lon, centre)` now also receives the chosen centre object (`{ id, lat, lon, userKm, ...catalog fields }` for a store, or `{ id: null, lat, lon }` for a centroid). `planProbe(uncovered, catalog, probe)` takes the same options. Existing walmart behaviour (defaults) unchanged.

- [ ] **Step 1: Failing tests** — append to `test/stock-search.test.js`:

```js
describe("probe options", () => {
  // Stores 60 km apart in a line; a 5-store / 90 km probe centred on a store reaches only its neighbours.
  const line = [];
  for (let i = 0; i < 30; i++) line.push({ id: `l${i}`, lat: 45, lon: -75 + i * 0.76, postalCode: `P${i}` });
  const lineById = new Map(line.map((s) => [s.id, s]));
  const lineUser = { lat: 45, lon: -75 };
  const lineApi = (inStock, seen) => vi.fn(async (lat, lon, centre) => {
    seen?.push(centre);
    return line
      .map((s) => ({ s, d: haversineKm({ lat, lon }, s) })).filter(({ d }) => d <= 90).sort((a, b) => a.d - b.d).slice(0, 5)
      .map(({ s, d }) => ({ id: s.id, name: s.id, address: "", postalCode: s.postalCode, status: inStock.has(s.id) ? "available" : "out_of_stock", distanceKm: d, accessPointId: null, url: null }));
  });
  const lineNearby = (inStock) => line.slice(0, 5).map((s) => ({ id: s.id, status: inStock.has(s.id) ? "available" : "out_of_stock", distanceKm: haversineKm(lineUser, s) }));

  it("planProbe with centroids disabled only ever returns a catalog store", () => {
    const uncovered = line.slice(5).map((s) => ({ ...s, userKm: haversineKm(lineUser, s) }));
    const c = planProbe(uncovered, line, { maxCount: 5, radiusKm: 90, centroids: false });
    expect(c.id).toBe("l5");
    expect(c.postalCode).toBe("P5");
  });

  it("passes the chosen centre (with its catalog fields) to fetchAround and honours maxCount/radius", async () => {
    const seen = [];
    const api = lineApi(new Set(["l12"]), seen);
    const res = await findNearestInStock({ nearby: lineNearby(new Set()), user: lineUser, catalog: line, fetchAround: api,
      maxCalls: 20, probe: { maxCount: 5, radiusKm: 90, centroids: false } });
    expect(res.inStock.map((s) => s.id)).toEqual(["l12"]);
    expect(res.complete).toBe(true);
    for (const c of seen) { expect(c.id).toMatch(/^l\d+$/); expect(c.postalCode).toMatch(/^P\d+$/); }
    // 5 stores per call spaced 60 km: reaching l12 from l5 takes 2-3 calls, never 20.
    expect(api.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it("keeps the default (walmart) behaviour when no options are given", async () => {
    const api = fakeApi(new Set(["e7"]));
    const res = await findNearestInStock({ nearby: nearby(new Set()), user: USER, catalog, fetchAround: api });
    expect(res.inStock[0].id).toBe("e7");
    expect(api.mock.calls[0].length).toBe(3); // lat, lon, centre
  });
});
```

- [ ] **Step 2: Run** `npx vitest run test/stock-search.test.js` -> FAIL (`planProbe` ignores options / `centre` undefined).

- [ ] **Step 3: Implement** in `src/lib/stock-search.js`:

- Replace the module constants with defaults: `export const DEFAULT_PROBE = { maxCount: 50, radiusKm: 100, centroids: true };` (keep `PROBE_MAX_COUNT`/`PROBE_RADIUS_KM` exported as aliases of the defaults for existing imports, if any).
- `simulateProbe(centre, catalog, probe)` filters by `probe.radiusKm` and slices to `probe.maxCount`.
- `planProbe(uncovered, catalog = uncovered, probe = DEFAULT_PROBE)`: merge `{ ...DEFAULT_PROBE, ...probe }`; when `centroids` is false, candidates are only the nearest `CANDIDATES` uncovered stores (skip the centroid loop); the returned candidate is the full uncovered entry (it already spreads catalog fields, so `postalCode` etc. survive — make sure the uncovered mapping in `findNearestInStock` uses `{ ...s, userKm }` rather than picking fields).
- `findNearestInStock({ ..., probe = {} })`: `const p = { ...DEFAULT_PROBE, ...probe }`; call `planProbe(uncovered, catalog, p)`; call `fetchAround(centre.lat, centre.lon, centre)`.
- Update the header comment to say the probe shape is configurable (walmart: 50 within 100 km with centroid candidates; staples: 5 within ~90 km, store-seeded).

- [ ] **Step 4: Run** `npx vitest run` -> pass (walmart tests untouched). Commit: `git add src/lib/stock-search.js test/stock-search.test.js && git commit -m "feat: configurable probe shape and centre hand-off in stock-search"`.

---

### Task 4: Staples client, store list, content script, manifest, e2e

**Files:**
- Create: `src/retailers/staples/api.js`, `src/retailers/staples/content.js`, `tools/build-staples-stores.mjs`, `src/retailers/staples/stores-ca.json`, `test/staples-api.test.js`, `test/staples-search.test.js`
- Modify: `src/manifest.json`, `docs/staples-ca-endpoints.md` (e2e section), `docs/superpowers/specs/2026-09-15-multi-retailer-design.md` (status line)

**Interfaces:**
- Consumes: Task 1 `skuFromHandle`, Task 2 parsers, Task 3 `findNearestInStock` with `probe` + centre hand-off, `locateUser`/`haversineKm` from `src/lib/geo.js`, `rankStores`, `toErrorResponse`, `WalmartApiError`/`apiChanged`.
- Produces: `api.js` exporting `buildProductUrl(handle)`, `buildAvailabilityBody(sku, postalCode)`, `AVAILABILITY_URL`, `getItem(handle) -> Item`, `getAvailability(sku, postalCode) -> Store[]`; `content.js` handling the four message types; `stores-ca.json` with 302 stores; manifest host permissions for `www.staples.ca` and `api.staples.ca`.

- [ ] **Step 1: Failing client tests**

`test/staples-api.test.js`:

```js
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { getItem, getAvailability, buildProductUrl, buildAvailabilityBody, AVAILABILITY_URL } from "../src/retailers/staples/api.js";

const fx = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8");
const jsonResponse = (body, status = 200) => new Response(body, { status, headers: { "content-type": "application/json" } });
const HANDLE = "3082604-en-brother-hl-l2405w-home-office-ready-monochrome-laser-printer";

describe("staples request builders", () => {
  it("buildProductUrl targets the Shopify product .js for the full handle", () => {
    expect(buildProductUrl(HANDLE)).toBe(`https://www.staples.ca/products/${HANDLE}.js`);
  });
  it("buildAvailabilityBody sends the documented PickInStore body", () => {
    expect(buildAvailabilityBody("3082604", "M5V 3L9")).toEqual({
      locale: "en-CA", postal_code: "M5V 3L9", items: [{ sku: "3082604", quantity: 1000 }], location: "PickInStore",
    });
    expect(AVAILABILITY_URL).toBe("https://api.staples.ca/ecommerce/inventory/v2.0/request");
  });
});

describe("staples fetching", () => {
  let fetchMock;
  beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock); });
  afterEach(() => vi.unstubAllGlobals());

  it("getItem fetches with credentials omitted and parses the product", async () => {
    fetchMock.mockResolvedValue(jsonResponse(fx("staples-product.json")));
    const item = await getItem(HANDLE);
    expect(item.retailer).toBe("staples");
    expect(item.id).toBe(HANDLE);
    expect(fetchMock.mock.calls[0][1].credentials).toBe("omit");
  });
  it("getItem maps a 404 to not_found", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 404 }));
    await expect(getItem("99999999-en-nope")).rejects.toMatchObject({ code: "not_found" });
  });
  it("getAvailability POSTs JSON with credentials omitted and parses the stores", async () => {
    fetchMock.mockResolvedValue(jsonResponse(fx("staples-availability.json")));
    const stores = await getAvailability("3082604", "M5V 3L9");
    expect(stores.length).toBeGreaterThan(0);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(AVAILABILITY_URL);
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("omit");
    expect(init.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual(buildAvailabilityBody("3082604", "M5V 3L9"));
  });
  it("maps 400 postal-code validation to invalid_postal, 429 to rate_limited, HTML/403 to verification", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse('{"title":"One or more validation errors occurred.","status":400,"errors":{"PostalCode":["must match"]}}', 400));
    await expect(getAvailability("1", "M5V")).rejects.toMatchObject({ code: "invalid_postal" });
    fetchMock.mockResolvedValueOnce(new Response("", { status: 429 }));
    await expect(getAvailability("1", "M5V 3L9")).rejects.toMatchObject({ code: "rate_limited" });
    fetchMock.mockResolvedValueOnce(new Response("<html>", { status: 403, headers: { "content-type": "text/html" } }));
    await expect(getItem(HANDLE)).rejects.toMatchObject({ code: "verification" });
  });
});
```

- [ ] **Step 2: Run** -> FAIL. **Step 3: Implement** `src/retailers/staples/api.js`:

```js
// staples.ca endpoints (Shopify storefront + Staples inventory API). No cookies or
// headers beyond Content-Type are needed; the inventory endpoint's CORS rejects
// credentialed requests, so every call uses credentials: "omit".
// Endpoint details: docs/staples-ca-endpoints.md
import { parseProduct, parseAvailability } from "./parse.js";
import { WalmartApiError, apiChanged } from "../../lib/errors.js";

const ORIGIN = "https://www.staples.ca";
export const AVAILABILITY_URL = "https://api.staples.ca/ecommerce/inventory/v2.0/request";

export function buildProductUrl(handle) {
  return `${ORIGIN}/products/${encodeURIComponent(String(handle))}.js`;
}

export function buildAvailabilityBody(sku, postalCode) {
  return { locale: "en-CA", postal_code: postalCode, items: [{ sku: String(sku), quantity: 1000 }], location: "PickInStore" };
}

async function request(url, init = {}) {
  const res = await globalThis.fetch(url, { credentials: "omit", ...init, headers: { accept: "application/json", ...(init.headers ?? {}) } });
  const text = await res.text();
  const contentType = res.headers.get("content-type") ?? "";
  if (res.status === 403 || /text\/html/i.test(contentType) || /^\s*</.test(text)) throw new WalmartApiError("verification");
  if (res.status === 429) throw new WalmartApiError("rate_limited");
  if (res.status === 404) throw new WalmartApiError("not_found");
  if (res.status === 400 && /PostalCode/.test(text)) throw new WalmartApiError("invalid_postal");
  let json;
  try { json = JSON.parse(text); } catch { throw apiChanged(text); }
  if (!res.ok) throw apiChanged(text);
  return json;
}

export async function getItem(handle) {
  return parseProduct(await request(buildProductUrl(handle)), handle);
}

// The 5 nearest pickup stores to postalCode with live stock for sku (see parseAvailability).
export async function getAvailability(sku, postalCode) {
  const json = await request(AVAILABILITY_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(buildAvailabilityBody(sku, postalCode)),
  });
  return parseAvailability(json, sku);
}
```

- [ ] **Step 4: Failing search-wiring test** — `test/staples-search.test.js` tests the content script's search composition through an exported helper (keep `content.js` thin; put the composition in `src/retailers/staples/search.js`):

```js
import { describe, it, expect, vi } from "vitest";
import { searchInStock } from "../src/retailers/staples/search.js";
import { haversineKm } from "../src/lib/geo.js";

// 8 stores along a line 60 km apart; the API returns the 5 nearest within 90 km of the seed store's postal code.
const catalog = [];
for (let i = 0; i < 8; i++) catalog.push({ id: `${100 + i}`, name: `Staples ${i}`, address: `${i} Main St`, postalCode: `K${i}A 1A1`, lat: 45, lon: -75 + i * 0.76 });
const byPostal = new Map(catalog.map((s) => [s.postalCode, s]));
const USER = { lat: 45, lon: -75 };
const fakeApi = (inStock) => ({
  getAvailability: vi.fn(async (_sku, postalCode) => {
    const centre = byPostal.get(postalCode);
    return catalog.map((s) => ({ s, d: haversineKm(centre, s) })).filter(({ d }) => d <= 90).sort((a, b) => a.d - b.d).slice(0, 5)
      .map(({ s, d }) => ({ id: s.id, name: s.name, address: s.address, postalCode: s.postalCode, distanceKm: d, status: inStock.has(s.id) ? "available" : "out_of_stock", url: null }));
  }),
});
const nearby = (inStock) => catalog.slice(0, 5).map((s) => ({ id: s.id, name: s.name, address: s.address, postalCode: s.postalCode, distanceKm: haversineKm(USER, s), status: inStock.has(s.id) ? "available" : "out_of_stock", url: null }));

describe("staples searchInStock", () => {
  it("probes outward seeded with catalog stores' postal codes and stamps the product url", async () => {
    const api = fakeApi(new Set(["106"]));
    const res = await searchInStock({ sku: "1", nearby: nearby(new Set()), catalog, api, productUrl: "https://www.staples.ca/products/x" });
    expect(res.inStock.map((s) => s.id)).toEqual(["106"]);
    expect(res.inStock[0].url).toBe("https://www.staples.ca/products/x");
    expect(res.inStock[0].distanceKm).toBeCloseTo(haversineKm(USER, catalog[6]), 0);
    for (const call of api.getAvailability.mock.calls) expect(byPostal.has(call[1])).toBe(true);
    expect(res.complete).toBe(true);
  });
  it("returns nearby stock without a call", async () => {
    const api = fakeApi(new Set(["101"]));
    const res = await searchInStock({ sku: "1", nearby: nearby(new Set(["101"])), catalog, api, productUrl: "u" });
    expect(api.getAvailability).not.toHaveBeenCalled();
    expect(res.inStock[0].id).toBe("101");
  });
  it("reports noLocation when no nearby store is in the catalog", async () => {
    const api = fakeApi(new Set());
    const res = await searchInStock({ sku: "1", nearby: [{ id: "999", status: "out_of_stock", distanceKm: 1 }], catalog, api, productUrl: "u" });
    expect(res.noLocation).toBe(true);
  });
});
```

- [ ] **Step 5: Implement** `src/retailers/staples/search.js`:

```js
// Staples returns the 5 nearest pickup stores within ~90 km of a postal code and
// accepts no store list, so the nationwide search is walmart's outward prober with
// a 5-store / 90 km probe shape, each probe seeded with a catalog store's postal code.
import { findNearestInStock } from "../../lib/stock-search.js";
import { locateUser } from "../../lib/geo.js";

export const SEARCH_MAX_CALLS = 40;
export const SEARCH_GAP_MS = 1000;
const PROBE = { maxCount: 5, radiusKm: 90, centroids: false };

export async function searchInStock({ sku, nearby, checkedIds = [], onProgress, api, catalog, productUrl, gapMs = SEARCH_GAP_MS, maxCalls = SEARCH_MAX_CALLS }) {
  const coords = new Map(catalog.map((s) => [s.id, s]));
  const user = locateUser(nearby, coords);
  const withUrl = (s) => ({ ...s, url: productUrl });
  if (!user) {
    return { inStock: nearby.filter((s) => s.status === "available").map(withUrl), searched: nearby.length, checkedIds: nearby.map((s) => s.id), complete: false, rateLimited: false, noLocation: true };
  }
  const known = new Set(nearby.map((s) => s.id));
  const seed = [...nearby, ...checkedIds.filter((id) => !known.has(id)).map((id) => ({ id, status: "unknown", distanceKm: null }))];
  const result = await findNearestInStock({
    nearby: seed, user, catalog, onProgress, maxCalls, gapMs, probe: PROBE,
    fetchAround: (_lat, _lon, centre) => api.getAvailability(sku, centre.postalCode),
  });
  return { ...result, inStock: result.inStock.map(withUrl) };
}
```

- [ ] **Step 6: Content script** `src/retailers/staples/content.js`:

```js
// Runs on https://www.staples.ca/*. Answers messages from the background worker.
import * as api from "./api.js";
import { searchInStock } from "./search.js";
import { skuFromHandle } from "./urls.js";
import catalog from "./stores-ca.json";
import { toErrorResponse, WalmartApiError } from "../../lib/errors.js";

function reportProgress(progress) {
  chrome.runtime.sendMessage({ type: "searchProgress", ...progress }).catch(() => {});
}

function skuOf(handle) {
  const sku = skuFromHandle(handle);
  if (!sku) throw new WalmartApiError("not_found");
  return sku;
}

async function handle(msg) {
  switch (msg?.type) {
    case "ping":
      return { ok: true };
    case "lookup": {
      const sku = skuOf(msg.itemId);
      const [item, stores] = await Promise.all([api.getItem(msg.itemId), api.getAvailability(sku, msg.postalCode)]);
      return { ok: true, item, stores: stores.map((s) => ({ ...s, url: item.url })) };
    }
    case "findInStock": {
      if (!Array.isArray(msg.nearby)) return { ok: false, code: "unknown", error: "findInStock needs the nearby store list." };
      const result = await searchInStock({
        sku: skuOf(msg.itemId), nearby: msg.nearby, checkedIds: msg.checkedIds ?? [], onProgress: reportProgress,
        api, catalog: catalog.stores, productUrl: msg.itemUrl ?? `https://www.staples.ca/products/${msg.itemId}`,
      });
      return { ok: true, ...result };
    }
    case "selectStore":
      return { ok: false, code: "unsupported", error: "Staples does not support selecting a store from here; open the product page instead." };
    default:
      return { ok: false, code: "unknown", error: `Unknown message type: ${msg?.type}` };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handle(msg).then(sendResponse, (err) => sendResponse(toErrorResponse(err)));
  return true;
});
```

- [ ] **Step 7: Store list tool** `tools/build-staples-stores.mjs` (build-time only; the Algolia app id and search-only key are public, from `window.ENV.algolia_API`):

```js
// Dev-only. Builds src/retailers/staples/stores-ca.json from Staples' public Algolia
// store_locations index (302 stores in one call). docs/staples-ca-endpoints.md §4
//   node tools/build-staples-stores.mjs
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "retailers", "staples", "stores-ca.json");
const URL = "https://H5YOVYKINU-dsn.algolia.net/1/indexes/store_locations/query";
const HEADERS = { "content-type": "application/json", "x-algolia-application-id": "H5YOVYKINU", "x-algolia-api-key": "4689de77d9aedbf48bf24a6da6cbebdd" };
const POSTAL = /([A-Za-z]\d[A-Za-z]\s?\d[A-Za-z]\d)\s*$/;

const res = await fetch(URL, { method: "POST", headers: HEADERS, body: JSON.stringify({ params: "query=&hitsPerPage=1000" }) });
if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
const { hits } = await res.json();
const stores = [];
for (const h of hits) {
  const lat = Number(h.lat ?? h._geoloc?.lat), lon = Number(h.lng ?? h._geoloc?.lng);
  const postal = (String(h.store_address ?? "").match(POSTAL) ?? [])[1];
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !postal || h.store_number == null) { console.log("skipped", JSON.stringify(h).slice(0, 120)); continue; }
  const [street = "", cityProv = ""] = String(h.store_address).split(" / ");
  stores.push({ id: String(h.store_number), name: `Staples ${h.store ?? ""}`.trim(), address: `${street.trim()}, ${cityProv.trim()}`, postalCode: postal.toUpperCase().replace(/^(\w{3})\s?(\w{3})$/, "$1 $2"), lat, lon });
}
stores.sort((a, b) => Number(a.id) - Number(b.id));
writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), stores }) + "\n");
console.log(`done: ${stores.length} stores (${hits.length} hits) -> ${OUT}`);
```

Run `node tools/build-staples-stores.mjs`; expect ~302 stores, 0 skipped (or explain each skip). Sanity: `node -e "import('./src/retailers/staples/stores-ca.json',{with:{type:'json'}}).then(m=>{const s=m.default.stores;console.log(s.length,new Set(s.map(x=>x.id)).size,s.filter(x=>!/^[A-Z]\d[A-Z] \d[A-Z]\d$/.test(x.postalCode)).length)})"` -> `302 302 0`.

- [ ] **Step 8: Manifest** — add `"https://www.staples.ca/*"` and `"https://api.staples.ca/*"` to `host_permissions`, add `{ "matches": ["https://www.staples.ca/*"], "js": ["content/staples.js"], "run_at": "document_idle" }` to `content_scripts`, update `name`/`description`/`default_title` to include Staples, and the popup `<title>`.

- [ ] **Step 9: Tests + build**: `npx vitest run && npm run build && ls dist/content` -> `staples.js` present.

- [ ] **Step 10: End-to-end** in a scratch-profile Chrome (`--remote-debugging-port=9223 --enable-unsafe-extension-debugging --user-data-dir=<fresh dir>`, start URL `https://www.staples.ca/`), loaded with the scratchpad `loadext.mjs` and driven with `e2e.mjs` (both in `C:\Users\hmai\AppData\Local\Temp\claude\c--Users-hmai-Desktop-opencv-walmart\965fb167-360c-4992-a6f1-fe4960af82cf\scratchpad\`; read them first). Postal `M5V 3L9`:
  1. `https://www.staples.ca/products/14336-en-staples-copy-paper-20-lb-85-w-x-11-h-white-5000-sheets` -> nearby list with stock, "Nearest in stock" box, "Open product page" opens the canonical URL.
  2. A scarce item (find one by querying the inventory endpoint from Node for a few printer/console SKUs until one has `availableqty: 0` at all 5 Toronto stores but stock at some other postal code, e.g. `H3B 2Y3` or `T2P 1J9`) -> progress line, then a far store in the box with a distance.
  3. `https://www.staples.ca/products/99999999-en-nothing` -> "Item not found."
  Record a short "End-to-end check" section at the end of `docs/staples-ca-endpoints.md`; close the Chrome.

- [ ] **Step 11: Spec status + commit** — spec `Status:` line -> "implemented for walmart + bestbuy + staples on 2026-09-15; shoppers/gamestop pending discovery".

```bash
git add src/retailers/staples src/manifest.json src/popup/popup.html tools/build-staples-stores.mjs test/staples-api.test.js test/staples-search.test.js docs/staples-ca-endpoints.md docs/superpowers/specs/2026-09-15-multi-retailer-design.md
git commit -m "feat: staples adapter (client, outward search, content script, store list, manifest)"
```

---

### Task 5: Docs

**Files:** `README.md`, `docs/superpowers/specs/2026-09-15-multi-retailer-design.md`

- [ ] **Step 1:** README: title `# Pickup Finder (walmart.ca, bestbuy.ca, staples.ca)`; intro lists Staples; "How it works" mentions `docs/staples-ca-endpoints.md` and that Staples rows open the product page; tools line adds `tools/build-staples-stores.mjs`; note that Staples shows the 5 nearest stores (the API's cap) and probes outward 5 stores at a time.
- [ ] **Step 2:** Spec: in "Constraints" add a bullet that staples.ca returns 5 stores within ~90 km per postal code and therefore reuses the outward prober with a small probe shape (`probe` option in `lib/stock-search.js`).
- [ ] **Step 3:** `npx vitest run`; commit `docs: staples in readme and spec`.

---

## Self-review

- Spec coverage: URL detection (T1), parsers (T2), search strategy per the discovery doc via a generalised prober (T3, T4), content script/manifest/e2e (T4), docs (T5); store list from Algolia at build time only; `credentials: "omit"`; error mapping incl. `invalid_postal` from the 400 body; empty-map disambiguation via the product call (`not_found` on 404, `pickupEligible` from tags — the popup already hides the notice and skips the search when statuses are unknown).
- Placeholders: none; discovery already done.
- Type consistency: `parseProductUrl -> handle`, `skuFromHandle`, `getAvailability(sku, postalCode) -> Store[]`, `searchInStock({ sku, nearby, checkedIds, onProgress, api, catalog, productUrl })`, `findNearestInStock(..., probe)` + `fetchAround(lat, lon, centre)`, catalog entries carry `postalCode`.
