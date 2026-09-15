# Multi-Retailer Pickup Finder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the popup accept a product URL from any supported retailer, route the lookup to a content script on that retailer's domain through a per-retailer adapter, and add Best Buy as the first adapter after Walmart.

**Architecture:** One extension, one adapter directory per retailer under `src/retailers/<name>/` with a pure `urls.js` (popup/background) and a `content.js` bundle (runs on that domain). `src/retailers/index.js` is the registry; background picks the tab by the adapter's `host`; popup only sees the shared `Item`/`Store`/`SearchResult` shapes. Walmart is moved onto the framework unchanged; Best Buy is added after an endpoint-discovery round recorded in `docs/bestbuy-ca-endpoints.md`.

**Tech Stack:** Chrome MV3 extension, plain ES modules, esbuild (`build.mjs`), vitest 2, Node 24+, Chrome DevTools Protocol dev tools (`tools/eval.js`, `tools/capture.js`).

**Spec:** `docs/superpowers/specs/2026-09-15-multi-retailer-design.md`

## Global Constraints

- Every retailer call runs inside a content script on that retailer's own domain (cookies + bot protection); popup and background never call retailer sites.
- Shared wire shapes: `Item { id, name, priceString, imageUrl, url, retailer }`, `Store { id, name, address, postalCode, distanceKm|null, status: "available"|"out_of_stock"|"unknown", url, accessPointId? }`, `SearchResult { inStock, searched, checkedIds, complete, rateLimited, noLocation? }`.
- Error codes (unchanged plus one): `no_tab`, `verification`, `invalid_postal`, `not_found`, `api_changed`, `rate_limited`, `unsupported`, `unknown`.
- Bare item id input still means Walmart.
- Non-Walmart store rows only open the product page (`store.url`).
- Tests: `npm test` (vitest). Build: `npm run build` -> `dist/`.
- Source files in this repo are saved with LF; git normalises (autocrlf). When editing with scripts, normalise CRLF first (`sed -i 's/\r$//' <file>`), otherwise multi-line matches fail.
- Commit after every task; do not push unless asked.

---

## File structure

```
src/
  retailers/
    index.js                    registry: RETAILERS, parseProductUrl
    walmart/
      urls.js                   id, label, host, homeUrl, parseProductUrl   (moved from lib/parse-item-id.js)
      content.js                content script                              (moved from content/index.js)
      api.js                    walmart.ca client                           (moved from content/walmart-api.js)
      parse.js                  parsers                                     (moved from lib/parse-walmart.js)
      stores-ca.json            store coordinates                           (moved from lib/)
    bestbuy/
      urls.js
      content.js
      api.js
      parse.js
  lib/                          geo.js, stock-search.js, rank-stores.js, errors.js, postal-code.js (unchanged)
  background.js                 routes by retailer
  popup/                        popup.html, popup.js, popup.css
  manifest.json                 5 hosts, one content script per host
build.mjs                       one entry per src/retailers/*/content.js -> dist/content/<name>.js
test/
  retailers.test.js             parseProductUrl across adapters
  background.test.js            tab routing per retailer
  walmart-*.test.js             existing tests, paths updated
  bestbuy-parse.test.js, bestbuy-api.test.js, bestbuy-search.test.js
  fixtures/bestbuy-*.json
docs/bestbuy-ca-endpoints.md
```

---

### Task 1: Retailer registry with the Walmart URL adapter

**Files:**
- Create: `src/retailers/walmart/urls.js` (from `src/lib/parse-item-id.js`)
- Create: `src/retailers/index.js`
- Create: `test/retailers.test.js`
- Move: `test/parse-item-id.test.js` -> `test/walmart-urls.test.js`
- Modify: `src/popup/popup.js` (import path only, full popup change is Task 4)

**Interfaces:**
- Produces: `src/retailers/walmart/urls.js` exporting `{ id: "walmart", label: "Walmart", host: "www.walmart.ca", homeUrl: "https://www.walmart.ca/en", parseProductUrl(input) -> string|null, parseItemId }`.
- Produces: `src/retailers/index.js` exporting `RETAILERS` (object keyed by id) and `parseProductUrl(input) -> { retailer, itemId } | null`.

- [ ] **Step 1: Move the Walmart id parser into the adapter**

```bash
git mv src/lib/parse-item-id.js src/retailers/walmart/urls.js
git mv test/parse-item-id.test.js test/walmart-urls.test.js
sed -i 's/\r$//' src/retailers/walmart/urls.js test/walmart-urls.test.js
sed -i 's|../src/lib/parse-item-id.js|../src/retailers/walmart/urls.js|' test/walmart-urls.test.js
sed -i 's|../lib/parse-item-id.js|../retailers/walmart/urls.js|' src/popup/popup.js
```

Append to `src/retailers/walmart/urls.js`:

```js
export const id = "walmart";
export const label = "Walmart";
export const host = "www.walmart.ca";
export const homeUrl = "https://www.walmart.ca/en";
// Bare ids are accepted here (and only here): a bare id means walmart.
export const parseProductUrl = parseItemId;
```

- [ ] **Step 2: Write the failing registry test**

`test/retailers.test.js`:

```js
import { describe, it, expect } from "vitest";
import { RETAILERS, parseProductUrl } from "../src/retailers/index.js";

describe("parseProductUrl", () => {
  it("routes a walmart.ca product URL to the walmart adapter", () => {
    expect(parseProductUrl("https://www.walmart.ca/en/ip/PlayStation-5-Pro-Console/1SZQHN3LOSE0"))
      .toEqual({ retailer: "walmart", itemId: "1SZQHN3LOSE0" });
  });
  it("treats a bare id as walmart", () => {
    expect(parseProductUrl("6000208927194")).toEqual({ retailer: "walmart", itemId: "6000208927194" });
  });
  it("returns null for an unsupported site", () => {
    expect(parseProductUrl("https://www.amazon.ca/dp/B0CQ5ZXG6R")).toBeNull();
    expect(parseProductUrl("")).toBeNull();
  });
  it("every adapter declares id, label, host, homeUrl and parseProductUrl", () => {
    for (const [key, a] of Object.entries(RETAILERS)) {
      expect(a.id).toBe(key);
      expect(typeof a.label).toBe("string");
      expect(a.host).toMatch(/^[a-z0-9.-]+$/);
      expect(a.homeUrl).toMatch(new RegExp(`^https://${a.host.replace(/\./g, "\\.")}/`));
      expect(typeof a.parseProductUrl).toBe("function");
    }
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run test/retailers.test.js`
Expected: FAIL, "Failed to load url ../src/retailers/index.js".

- [ ] **Step 4: Write the registry**

`src/retailers/index.js`:

```js
// Registry of retailer adapters. Each entry is the adapter's pure `urls.js`
// (safe for popup and background: no network, no chrome APIs).
import * as walmart from "./walmart/urls.js";

export const RETAILERS = Object.fromEntries([walmart].map((a) => [a.id, a]));

// Adapters are tried in registry order; walmart is last because it also
// accepts bare ids, which no other adapter does.
const ORDER = [...Object.values(RETAILERS).filter((a) => a.id !== "walmart"), walmart];

export function parseProductUrl(input) {
  const s = String(input ?? "").trim();
  if (!s) return null;
  for (const a of ORDER) {
    const itemId = a.parseProductUrl(s);
    if (itemId) return { retailer: a.id, itemId };
  }
  return null;
}
```

- [ ] **Step 5: Run all tests**

Run: `npx vitest run`
Expected: all pass (the moved walmart-urls tests included).

- [ ] **Step 6: Commit**

```bash
git add -A src/retailers src/popup/popup.js test/retailers.test.js test/walmart-urls.test.js
git commit -m "refactor: retailer registry with walmart url adapter"
```

---

### Task 2: Move the Walmart content script, client, parsers and store list under the adapter

**Files:**
- Move: `src/content/index.js` -> `src/retailers/walmart/content.js`
- Move: `src/content/walmart-api.js` -> `src/retailers/walmart/api.js`
- Move: `src/lib/parse-walmart.js` -> `src/retailers/walmart/parse.js`
- Move: `src/lib/stores-ca.json` -> `src/retailers/walmart/stores-ca.json`
- Move: `test/walmart-api.test.js`, `test/parse-walmart.test.js` -> `test/walmart-api.test.js`, `test/walmart-parse.test.js`
- Modify: `build.mjs`, `src/manifest.json`, `tools/build-store-list.mjs`, `tools/build-store-list-pages.mjs`, `docs/walmart-ca-endpoints.md` (paths)

**Interfaces:**
- Produces: `dist/content/walmart.js` bundle; manifest content script entry for `https://www.walmart.ca/*` pointing at it.
- Produces: `src/retailers/walmart/content.js` handling `ping`, `lookup`, `findInStock`, `selectStore` (behaviour unchanged).

- [ ] **Step 1: Move files and fix imports**

```bash
mkdir -p src/retailers/walmart
git mv src/content/index.js src/retailers/walmart/content.js
git mv src/content/walmart-api.js src/retailers/walmart/api.js
git mv src/lib/parse-walmart.js src/retailers/walmart/parse.js
git mv src/lib/stores-ca.json src/retailers/walmart/stores-ca.json
git mv test/parse-walmart.test.js test/walmart-parse.test.js
sed -i 's/\r$//' src/retailers/walmart/content.js src/retailers/walmart/api.js src/retailers/walmart/parse.js test/walmart-api.test.js test/walmart-parse.test.js
# content.js
sed -i 's|"./walmart-api.js"|"./api.js"|; s|"../lib/rank-stores.js"|"../../lib/rank-stores.js"|; s|"../lib/geo.js"|"../../lib/geo.js"|; s|"../lib/stock-search.js"|"../../lib/stock-search.js"|; s|"../lib/errors.js"|"../../lib/errors.js"|; s|"../lib/stores-ca.json"|"./stores-ca.json"|' src/retailers/walmart/content.js
# api.js
sed -i 's|"../lib/parse-walmart.js"|"./parse.js"|; s|"../lib/errors.js"|"../../lib/errors.js"|' src/retailers/walmart/api.js
# parse.js
sed -i 's|"./errors.js"|"../../lib/errors.js"|' src/retailers/walmart/parse.js
# tests
sed -i 's|../src/content/walmart-api.js|../src/retailers/walmart/api.js|' test/walmart-api.test.js
sed -i 's|../src/lib/parse-walmart.js|../src/retailers/walmart/parse.js|' test/walmart-parse.test.js
# tools write the store list
sed -i 's|"..", "src", "lib", "stores-ca.json"|"..", "src", "retailers", "walmart", "stores-ca.json"|' tools/build-store-list.mjs tools/build-store-list-pages.mjs
sed -i 's|src/lib/stores-ca.json|src/retailers/walmart/stores-ca.json|g; s|lib/parse-walmart.js|retailers/walmart/parse.js|g' docs/walmart-ca-endpoints.md
rmdir src/content
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run`
Expected: all pass. If an import path was missed, the error names the file.

- [ ] **Step 3: Build one bundle per adapter**

Replace the `entryPoints` block in `build.mjs`:

```js
import { readdirSync } from "node:fs";

const retailers = readdirSync("src/retailers", { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

await build({
  entryPoints: {
    ...Object.fromEntries(retailers.map((r) => [`content/${r}`, `src/retailers/${r}/content.js`])),
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
```

(keep the existing `rmSync`/`mkdirSync`/`cpSync` lines; move the `readdirSync` import next to the existing `node:fs` import.)

- [ ] **Step 4: Point the manifest at the new bundle**

`src/manifest.json` `content_scripts`:

```json
"content_scripts": [
  { "matches": ["https://www.walmart.ca/*"], "js": ["content/walmart.js"], "run_at": "document_idle" }
]
```

- [ ] **Step 5: Build and check output**

Run: `npm run build && ls dist/content`
Expected: `walmart.js` present, no `dist/content.js`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: move walmart content script, client, parsers and store list under src/retailers/walmart"
```

---

### Task 3: Background routes by retailer

**Files:**
- Modify: `src/background.js`
- Create: `test/background.test.js`

**Interfaces:**
- Consumes: `RETAILERS` from `src/retailers/index.js` (`host`, `homeUrl`).
- Produces: messages from the popup carry `retailer`; background answers `{ ok:false, code:"unsupported" }` for unknown ids; `selectStore` only opens URLs on that retailer's host. Exported for tests: `handle(msg, deps)`.

- [ ] **Step 1: Write the failing test**

`test/background.test.js` (background is a service worker; tests inject a fake `chrome` through `deps`):

```js
import { describe, it, expect, vi } from "vitest";
import { handle } from "../src/background.js";

function fakeChrome({ tabs = [], answers = {} } = {}) {
  const created = [];
  const chrome = {
    tabs: {
      query: vi.fn(async ({ url }) => tabs.filter((t) => new RegExp("^" + url.replace(/[.]/g, "\\.").replace("*", ".*")).test(t.url))),
      sendMessage: vi.fn(async (tabId, msg) => (msg.type === "ping" ? { ok: true } : answers[tabId] ?? { ok: true, echo: msg })),
      reload: vi.fn(async () => {}),
      create: vi.fn(async ({ url }) => { const t = { id: 100 + created.length, url }; created.push(t); tabs.push(t); return t; }),
    },
  };
  return { chrome, created };
}

describe("background handle", () => {
  it("forwards a lookup to a tab on the retailer's host", async () => {
    const { chrome } = fakeChrome({ tabs: [{ id: 1, url: "https://www.walmart.ca/en" }, { id: 2, url: "https://www.bestbuy.ca/en-ca" }] });
    const res = await handle({ type: "lookup", retailer: "walmart", itemId: "1", postalCode: "M5V 3L9" }, { chrome });
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(1, expect.objectContaining({ type: "lookup" }));
    expect(res.echo.itemId).toBe("1");
  });
  it("opens the retailer's home page when no tab exists", async () => {
    const { chrome, created } = fakeChrome();
    await handle({ type: "lookup", retailer: "walmart", itemId: "1", postalCode: "M5V 3L9" }, { chrome, sleepMs: 0 });
    expect(created[0].url).toBe("https://www.walmart.ca/en");
  });
  it("rejects an unknown retailer", async () => {
    const { chrome } = fakeChrome();
    expect(await handle({ type: "lookup", retailer: "sears" }, { chrome })).toMatchObject({ ok: false, code: "unsupported" });
  });
  it("refuses to open a product URL on another host after selectStore", async () => {
    const { chrome } = fakeChrome({ tabs: [{ id: 1, url: "https://www.walmart.ca/en" }] });
    const res = await handle({ type: "selectStore", retailer: "walmart", store: {}, postalCode: "M5V 3L9", itemUrl: "https://evil.example/x" }, { chrome });
    expect(res.ok).toBe(false);
    expect(chrome.tabs.create).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/background.test.js`
Expected: FAIL, `handle` is not exported (and `chrome` is undefined at module load if the listener registration is unguarded).

- [ ] **Step 3: Rewrite background.js**

```js
// Routes popup messages to the content script of the retailer named in the message.
import { ERROR_MESSAGES } from "./lib/errors.js";
import { RETAILERS } from "./retailers/index.js";

const READY_TIMEOUT_MS = 15000;
const READY_POLL_MS = 500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ping(chrome, tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: "ping" });
    return res?.ok === true;
  } catch {
    return false;
  }
}

// Returns a tab id on the adapter's host whose content script answers ping, opening one if needed.
async function getTab(chrome, adapter, sleepMs) {
  const tabs = await chrome.tabs.query({ url: `https://${adapter.host}/*` });
  for (const t of tabs) if (await ping(chrome, t.id)) return t.id;
  // A tab opened before the extension was installed/reloaded has no content script until reloaded.
  let target = tabs[0];
  if (target) await chrome.tabs.reload(target.id);
  else target = await chrome.tabs.create({ url: adapter.homeUrl, active: false });
  const deadline = Date.now() + (sleepMs === 0 ? 0 : READY_TIMEOUT_MS);
  do {
    if (await ping(chrome, target.id)) return target.id;
    await sleep(sleepMs ?? READY_POLL_MS);
  } while (Date.now() < deadline);
  return null;
}

async function forward(chrome, adapter, msg, sleepMs) {
  const tabId = await getTab(chrome, adapter, sleepMs);
  if (tabId == null) return { ok: false, code: "no_tab", error: ERROR_MESSAGES.no_tab };
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch {
    return { ok: false, code: "no_tab", error: ERROR_MESSAGES.no_tab };
  }
}

// deps: { chrome, sleepMs } — injected so tests can run without a service worker.
export async function handle(msg, { chrome = globalThis.chrome, sleepMs } = {}) {
  const adapter = RETAILERS[msg?.retailer];
  if (!adapter) return { ok: false, code: "unsupported", error: ERROR_MESSAGES.unsupported };
  switch (msg?.type) {
    case "lookup":
    case "findInStock":
      return forward(chrome, adapter, msg, sleepMs);
    case "selectStore": {
      const res = await forward(chrome, adapter, msg, sleepMs);
      if (typeof msg.itemUrl !== "string" || !msg.itemUrl.startsWith(`https://${adapter.host}/`)) {
        return { ok: false, code: "unknown", error: `Refused to open a URL outside ${adapter.host}.` };
      }
      await chrome.tabs.create({ url: msg.itemUrl, active: true });
      return res;
    }
    default:
      return { ok: false, code: "unknown", error: `Unknown message type: ${msg?.type}` };
  }
}

if (globalThis.chrome?.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!sender.url?.startsWith(chrome.runtime.getURL("/"))) return false; // only extension pages (the popup) talk to the background
    handle(msg).then(sendResponse, (err) => sendResponse({ ok: false, code: "unknown", error: String(err?.message ?? err) }));
    return true;
  });
}
```

Add to `ERROR_MESSAGES` in `src/lib/errors.js`:

```js
  unsupported: "This store is not supported yet. Paste a product URL from Walmart or Best Buy.",
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/background.js src/lib/errors.js test/background.test.js
git commit -m "feat: background routes messages to the retailer named in the message"
```

---

### Task 4: Popup accepts any supported product URL

**Files:**
- Modify: `src/popup/popup.js`, `src/popup/popup.html`

**Interfaces:**
- Consumes: `parseProductUrl` and `RETAILERS` from `src/retailers/index.js`.
- Produces: every message sent from the popup carries `retailer`; `state.retailer` set on lookup.

- [ ] **Step 1: Change input parsing and message shapes**

In `src/popup/popup.js`:

Replace the import line for the walmart parser with:

```js
import { parseProductUrl, RETAILERS } from "../retailers/index.js";
```

Add `retailer: ""` to `state`.

Replace the form submit handler body:

```js
$("form").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const parsed = parseProductUrl($("item").value);
  if (!parsed) { clearResults(); showError("Paste a product URL from Walmart, Best Buy, Staples, Shoppers Drug Mart or GameStop (or a Walmart item ID)."); return; }
  const postalCode = normalizePostalCode($("postal").value);
  if (!postalCode) { clearResults(); showError("Enter a valid Canadian postal code (e.g. M5V 3L9)."); return; }
  $("postal").value = postalCode;
  chrome.storage.local.set({ postalCode });
  lookup(parsed, postalCode);
});
```

Change `lookup(itemId, postalCode)` to `lookup({ retailer, itemId }, postalCode)`; inside it send `{ type: "lookup", retailer, itemId, postalCode }` and set `state.retailer = retailer` next to `state.itemId = itemId`.

Add `retailer: state.retailer` to the `findInStock` and `selectStore` messages.

In `renderItem`, show the retailer label:

```js
  $("itemName").textContent = `${RETAILERS[item.retailer]?.label ?? ""} · ${item.name}`.replace(/^ · /, "");
```

- [ ] **Step 2: Per-retailer store button**

In `storeRow(s)` replace the button wiring:

```js
  const btn = li.querySelector(".pickup");
  if (state.retailer === "walmart") {
    btn.textContent = "Order pickup";
    btn.disabled = !s.accessPointId;
    btn.addEventListener("click", () => orderPickup(s, btn));
  } else {
    btn.textContent = "Open product page";
    btn.disabled = !s.url;
    btn.addEventListener("click", () => chrome.tabs.create({ url: s.url }));
  }
```

Update the input label in `popup.html`:

```html
    <label>Product URL (Walmart, Best Buy, Staples, Shoppers, GameStop) or Walmart item ID
      <input id="item" type="text" placeholder="https://www.bestbuy.ca/en-ca/product/..." required>
    </label>
```

- [ ] **Step 3: Make the Walmart content script tag items and stores**

In `src/retailers/walmart/parse.js` `parseItem` add `retailer: "walmart"` to the returned object, and in `parseStores` add `url: null` per store (walmart rows use setPickup, not a per-store URL). Update `test/walmart-parse.test.js` expectations if they compare whole objects (search for `toEqual(` on parsed items/stores and add the two fields).

- [ ] **Step 4: Build, run tests, and smoke-test in Chrome**

Run: `npx vitest run && npm run build`
Expected: pass, build ok.

Manual: launch a scratch-profile Chrome with `--remote-debugging-port=9223 --enable-unsafe-extension-debugging`, load `dist/` through the DevTools protocol `Extensions.loadUnpacked` (the scratchpad script `loadext.mjs` from the previous session did exactly this; recreate it if missing: connect to `/json/version`, send `Extensions.loadUnpacked { path: "<abs path to dist>" }`), open `chrome-extension://<id>/popup/popup.html` in a tab, paste a walmart URL + `M5V 3L9`, confirm results still render and "Order pickup" still works.

- [ ] **Step 5: Commit**

```bash
git add src/popup src/retailers/walmart/parse.js test/walmart-parse.test.js
git commit -m "feat: popup accepts product URLs from any registered retailer"
```

---

### Task 5: Best Buy endpoint discovery (no extension code)

**Files:**
- Create: `docs/bestbuy-ca-endpoints.md`
- Create: `test/fixtures/bestbuy-availability.json`, `test/fixtures/bestbuy-stores.json`, `test/fixtures/bestbuy-product.json`

**Interfaces:**
- Produces: the documented request shapes and the fields Task 7/8 parse. Tasks 6-9 treat this document as authoritative; where the code below guesses a field name, the implementer replaces it with the documented one.

- [ ] **Step 1: Launch a debug Chrome on bestbuy.ca**

PowerShell:

```powershell
$prof = "$env:TEMP\bb-profile"; New-Item -ItemType Directory -Force $prof | Out-Null
Start-Process "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe" -ArgumentList "--remote-debugging-port=9222","--user-data-dir=$prof","--no-first-run","--no-default-browser-check","https://www.bestbuy.ca/en-ca/product/playstation-5-pro-console/18291446"
```

Then `node tools/capture.js` in a second terminal (it attaches to every page and writes `walmart-capture.jsonl`; the host filter is `HOST_RE = /walmart\.ca/i` at the top of the file: change it to `/bestbuy\.ca/i` for this session and leave the change uncommitted or make it an env var `CAPTURE_HOST`).

- [ ] **Step 2: Trigger the calls**

On the product page: click the store-availability link ("Check other stores" / "See availability in stores"), enter postal code `M5V 3L9`, page through results. Then open the store locator (`/en-ca/stores`) and search the same postal code.

- [ ] **Step 3: Extract the endpoints**

Run `node tools/grep-capture.js` after replacing its keyword list with `["availability", "pickup", "locations", "stores", "postalCode", "sku"]`, then read the matching entries in `walmart-capture.jsonl`. Record in `docs/bestbuy-ca-endpoints.md`, same sections as the walmart doc:

1. Product details endpoint (or the product page's embedded JSON): name, price, image, canonical URL.
2. Availability endpoint: method, URL, query/body (SKU list, location list, postal code), required headers (verify by removing each header with `tools/eval.js` and re-sending), the per-store status field and its values, and how many locations one call accepts (try 10, 50, all).
3. Store list endpoint: parameters (postal code / lat-lon / radius / count), fields per store (id, name, address, lat, lon, distance).
4. Errors: unknown SKU, invalid postal code, bot challenge (status + body), rate limiting (send 40 calls 1 s apart via `tools/eval.js` and note when/if 429 appears and how long it lasts).
5. `x-o-*`-style tenant headers if any.

Save one real response per endpoint (cookies stripped, trimmed to a handful of stores) as the three fixtures.

- [ ] **Step 4: Decide the search strategy and write it down**

At the end of the doc, state one of:
- "Availability accepts N locations per call; full-country search = ceil(stores/N) calls" -> Task 8 implements the batched pass.
- "Availability is per location only" -> Task 8 instead reuses `lib/stock-search.js` with `findStoresAround` built from the store list endpoint (same as walmart).

- [ ] **Step 5: Commit**

```bash
git add docs/bestbuy-ca-endpoints.md test/fixtures/bestbuy-*.json
git commit -m "docs: bestbuy.ca endpoints and fixtures"
```

---

### Task 6: Best Buy URL adapter

**Files:**
- Create: `src/retailers/bestbuy/urls.js`
- Create: `test/bestbuy-urls.test.js`
- Modify: `src/retailers/index.js`, `test/retailers.test.js`

**Interfaces:**
- Produces: `{ id: "bestbuy", label: "Best Buy", host: "www.bestbuy.ca", homeUrl: "https://www.bestbuy.ca/en-ca", parseProductUrl }`.

- [ ] **Step 1: Write the failing test**

`test/bestbuy-urls.test.js`:

```js
import { describe, it, expect } from "vitest";
import { parseProductUrl } from "../src/retailers/bestbuy/urls.js";

describe("bestbuy parseProductUrl", () => {
  it("extracts the sku from an English product URL", () => {
    expect(parseProductUrl("https://www.bestbuy.ca/en-ca/product/playstation-5-pro-console/18291446")).toBe("18291446");
  });
  it("extracts the sku from a French URL with query string", () => {
    expect(parseProductUrl("https://www.bestbuy.ca/fr-ca/produit/console-playstation-5-pro/18291446?icmp=x")).toBe("18291446");
  });
  it("rejects bare ids and other hosts", () => {
    expect(parseProductUrl("18291446")).toBeNull();
    expect(parseProductUrl("https://www.walmart.ca/en/ip/x/6000208927194")).toBeNull();
  });
});
```

Add to `test/retailers.test.js`:

```js
  it("routes a bestbuy.ca product URL to the bestbuy adapter", () => {
    expect(parseProductUrl("https://www.bestbuy.ca/en-ca/product/playstation-5-pro-console/18291446"))
      .toEqual({ retailer: "bestbuy", itemId: "18291446" });
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/bestbuy-urls.test.js test/retailers.test.js`
Expected: FAIL (module missing / null).

- [ ] **Step 3: Implement**

`src/retailers/bestbuy/urls.js` (adjust the path pattern to what the discovery doc shows):

```js
// bestbuy.ca product URLs: /en-ca/product/<slug>/<sku> or /fr-ca/produit/<slug>/<sku>; sku is numeric.
const URL_SKU = /^https?:\/\/(?:www\.)?bestbuy\.ca\/(?:en|fr)-ca\/(?:product|produit)\/(?:[^/?#]+\/)?(\d{5,10})(?=[/?#]|$)/i;

export const id = "bestbuy";
export const label = "Best Buy";
export const host = "www.bestbuy.ca";
export const homeUrl = "https://www.bestbuy.ca/en-ca";

export function parseProductUrl(input) {
  const m = String(input ?? "").trim().match(URL_SKU);
  return m ? m[1] : null;
}
```

Register it in `src/retailers/index.js`:

```js
import * as bestbuy from "./bestbuy/urls.js";
export const RETAILERS = Object.fromEntries([bestbuy, walmart].map((a) => [a.id, a]));
```

- [ ] **Step 4: Run tests, commit**

Run: `npx vitest run` -> pass.

```bash
git add src/retailers/bestbuy/urls.js src/retailers/index.js test/bestbuy-urls.test.js test/retailers.test.js
git commit -m "feat: bestbuy url adapter"
```

---

### Task 7: Best Buy parsers

**Files:**
- Create: `src/retailers/bestbuy/parse.js`
- Create: `test/bestbuy-parse.test.js`

**Interfaces:**
- Produces: `parseProduct(json) -> Item`, `parseStores(json) -> Array<{ id, name, address, postalCode, lat, lon, distanceKm }>`, `parseAvailability(json) -> Map<storeId, status>`. Field names below are the expected ones; replace them with the names recorded in `docs/bestbuy-ca-endpoints.md`.

- [ ] **Step 1: Write the failing tests against the fixtures**

`test/bestbuy-parse.test.js`:

```js
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseProduct, parseStores, parseAvailability } from "../src/retailers/bestbuy/parse.js";

const load = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8"));

describe("bestbuy parsers", () => {
  it("parseProduct maps the product fields", () => {
    const item = parseProduct(load("bestbuy-product.json"));
    expect(item.retailer).toBe("bestbuy");
    expect(item.id).toMatch(/^\d+$/);
    expect(item.name.length).toBeGreaterThan(3);
    expect(item.url).toMatch(/^https:\/\/www\.bestbuy\.ca\//);
    expect(item.priceString).toMatch(/^\$/);
  });
  it("parseStores maps id, address and coordinates", () => {
    const stores = parseStores(load("bestbuy-stores.json"));
    expect(stores.length).toBeGreaterThan(0);
    for (const s of stores) {
      expect(s.id).toMatch(/^\d+$/);
      expect(typeof s.lat).toBe("number");
      expect(typeof s.lon).toBe("number");
      expect(s.address).toContain(s.postalCode.slice(0, 3));
    }
  });
  it("parseAvailability maps every location to a status", () => {
    const av = parseAvailability(load("bestbuy-availability.json"));
    expect(av.size).toBeGreaterThan(0);
    for (const status of av.values()) expect(["available", "out_of_stock", "unknown"]).toContain(status);
  });
  it("parseProduct throws not_found for an unknown sku payload", () => {
    expect(() => parseProduct({})).toThrow(expect.objectContaining({ code: "not_found" }));
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/bestbuy-parse.test.js` -> FAIL (module missing).

- [ ] **Step 3: Implement against the documented fields**

`src/retailers/bestbuy/parse.js` (expected shape; rename per the doc):

```js
import { WalmartApiError, apiChanged } from "../../lib/errors.js";

const ORIGIN = "https://www.bestbuy.ca";
// Expected pickup status strings; confirm the exact set in docs/bestbuy-ca-endpoints.md.
const STATUS = { InStock: "available", InStoreOnly: "available", OutOfStock: "out_of_stock", SoldOut: "out_of_stock" };

export function parseProduct(json) {
  const p = json?.product ?? json;
  if (!p || typeof p !== "object" || !p.sku) throw new WalmartApiError("not_found");
  if (!p.name) throw apiChanged(JSON.stringify(json));
  const price = p.salePrice ?? p.regularPrice;
  return {
    id: String(p.sku),
    name: String(p.name),
    priceString: price == null ? "" : `$${Number(price).toFixed(2)}`,
    imageUrl: p.thumbnailImage ? String(p.thumbnailImage) : null,
    url: p.productUrl ? ORIGIN + p.productUrl : `${ORIGIN}/en-ca/product/${p.sku}`,
    retailer: "bestbuy",
  };
}

export function parseStores(json) {
  const list = json?.locations ?? json?.stores;
  if (!Array.isArray(list)) throw apiChanged(JSON.stringify(json));
  return list.map((s) => ({
    id: String(s.locationKey ?? s.id),
    name: String(s.name ?? ""),
    address: [s.address?.street, s.address?.city, s.address?.province].filter(Boolean).join(", "),
    postalCode: String(s.address?.postalCode ?? ""),
    lat: Number(s.latitude ?? s.geoPoint?.latitude),
    lon: Number(s.longitude ?? s.geoPoint?.longitude),
    distanceKm: Number.isFinite(Number(s.distance)) ? Number(s.distance) : null,
  }));
}

// -> Map<locationId, status>
export function parseAvailability(json) {
  const list = json?.availabilities?.[0]?.pickup?.locations ?? json?.locations;
  if (!Array.isArray(list)) throw apiChanged(JSON.stringify(json));
  return new Map(list.map((l) => [String(l.locationKey ?? l.id), STATUS[l.status] ?? (l.quantityOnHand > 0 ? "available" : "unknown")]));
}
```

(`WalmartApiError` is the shared error class; renaming it to `ApiError` across the repo is optional and out of scope.)

- [ ] **Step 4: Run tests, commit**

Run: `npx vitest run` -> pass.

```bash
git add src/retailers/bestbuy/parse.js test/bestbuy-parse.test.js
git commit -m "feat: bestbuy parsers"
```

---

### Task 8: Best Buy client and nationwide search

**Files:**
- Create: `src/retailers/bestbuy/api.js`
- Create: `src/retailers/bestbuy/search.js`
- Create: `test/bestbuy-api.test.js`, `test/bestbuy-search.test.js`

**Interfaces:**
- Consumes: parsers from Task 7; `haversineKm`, `locateUser` from `src/lib/geo.js`; `WalmartApiError`, `apiChanged` from `src/lib/errors.js`.
- Produces: `getItem(sku) -> Item`, `getStores(postalCode) -> stores near postal code (parsed)`, `getAllStores() -> every store`, `getAvailability(sku, locationIds[]) -> Map`, and `findNearestInStock({ sku, postalCode, nearby, checkedIds, onProgress, api }) -> SearchResult`.

- [ ] **Step 1: Write the failing client test**

`test/bestbuy-api.test.js`:

```js
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { getItem, getStores, getAvailability, buildAvailabilityUrl } from "../src/retailers/bestbuy/api.js";

const fx = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8");
const jsonResponse = (body, status = 200) => new Response(body, { status, headers: { "content-type": "application/json" } });

describe("bestbuy api", () => {
  let fetchMock;
  beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock); });
  afterEach(() => vi.unstubAllGlobals());

  it("buildAvailabilityUrl lists the sku and the locations", () => {
    const url = new URL(buildAvailabilityUrl("18291446", ["1", "2"], "M5V 3L9"));
    expect(url.hostname).toBe("www.bestbuy.ca");
    expect(url.searchParams.get("skus")).toBe("18291446");
    expect(url.searchParams.get("locations")).toBe("1|2");
  });
  it("getAvailability sends credentials and parses statuses", async () => {
    fetchMock.mockResolvedValue(jsonResponse(fx("bestbuy-availability.json")));
    const av = await getAvailability("18291446", ["1"], "M5V 3L9");
    expect(av.size).toBeGreaterThan(0);
    expect(fetchMock.mock.calls[0][1].credentials).toBe("include");
  });
  it("getItem parses the product", async () => {
    fetchMock.mockResolvedValue(jsonResponse(fx("bestbuy-product.json")));
    expect((await getItem("18291446")).retailer).toBe("bestbuy");
  });
  it("getStores parses the locator", async () => {
    fetchMock.mockResolvedValue(jsonResponse(fx("bestbuy-stores.json")));
    expect((await getStores("M5V 3L9")).length).toBeGreaterThan(0);
  });
  it("maps 403 HTML to verification and 429 to rate_limited", async () => {
    fetchMock.mockResolvedValueOnce(new Response("<html>", { status: 403, headers: { "content-type": "text/html" } }));
    await expect(getItem("1")).rejects.toMatchObject({ code: "verification" });
    fetchMock.mockResolvedValueOnce(new Response("", { status: 429 }));
    await expect(getItem("1")).rejects.toMatchObject({ code: "rate_limited" });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/bestbuy-api.test.js` -> FAIL.

- [ ] **Step 3: Implement the client**

`src/retailers/bestbuy/api.js` (URLs, params and headers come from the doc; the structure stays):

```js
// bestbuy.ca internal endpoints. Must run inside a bestbuy.ca page (cookies, bot clearance).
// Endpoint details: docs/bestbuy-ca-endpoints.md
import { parseProduct, parseStores, parseAvailability } from "./parse.js";
import { WalmartApiError, apiChanged } from "../../lib/errors.js";

const ORIGIN = "https://www.bestbuy.ca";
const LOCATIONS_PER_CALL = 50; // set from the doc's measured maximum

export function buildHeaders() {
  return { accept: "application/json", "content-type": "application/json" }; // plus any tenant headers the doc lists
}

export function buildAvailabilityUrl(sku, locationIds, postalCode) {
  const q = new URLSearchParams({ skus: String(sku), locations: locationIds.join("|"), postalCode, accept: "application/json" });
  return `${ORIGIN}/ecomm-api/availability/products?${q}`;
}

export function buildStoresUrl(postalCode, { lat, lon, radiusKm, count } = {}) {
  const q = new URLSearchParams({ postalCode: postalCode ?? "", lang: "en-CA" });
  if (lat != null) { q.set("lat", lat); q.set("lng", lon); }
  if (radiusKm != null) q.set("radius", radiusKm);
  if (count != null) q.set("count", count);
  return `${ORIGIN}/api/v2/json/locations?${q}`; // replace with the documented locator URL
}

export function buildProductUrl(sku) {
  return `${ORIGIN}/api/v2/json/product/${encodeURIComponent(String(sku))}?lang=en-CA`; // replace with the documented URL
}

async function get(url) {
  const res = await globalThis.fetch(url, { credentials: "include", headers: buildHeaders() });
  const text = await res.text();
  const contentType = res.headers.get("content-type") ?? "";
  if (res.status === 403 || /text\/html/i.test(contentType) || /^\s*</.test(text)) throw new WalmartApiError("verification");
  if (res.status === 429) throw new WalmartApiError("rate_limited");
  if (res.status === 404) throw new WalmartApiError("not_found");
  let json;
  try { json = JSON.parse(text); } catch { throw apiChanged(text); }
  if (!res.ok) throw apiChanged(text);
  return json;
}

export async function getItem(sku) { return parseProduct(await get(buildProductUrl(sku))); }
export async function getStores(postalCode, opts) { return parseStores(await get(buildStoresUrl(postalCode, opts))); }
export async function getAvailability(sku, locationIds, postalCode) {
  const out = new Map();
  for (let i = 0; i < locationIds.length; i += LOCATIONS_PER_CALL) {
    const batch = locationIds.slice(i, i + LOCATIONS_PER_CALL);
    for (const [k, v] of parseAvailability(await get(buildAvailabilityUrl(sku, batch, postalCode)))) out.set(k, v);
  }
  return out;
}
// All stores in Canada: the locator with a country-wide radius; the doc says which parameters achieve that.
export async function getAllStores() { return getStores(null, { lat: 56, lon: -96, radiusKm: 5000, count: 500 }); }
```

- [ ] **Step 4: Write the failing search test**

`test/bestbuy-search.test.js`:

```js
import { describe, it, expect, vi } from "vitest";
import { findNearestInStock } from "../src/retailers/bestbuy/search.js";
import { haversineKm } from "../src/lib/geo.js";

const USER = { lat: 43.64, lon: -79.39 };
const stores = [
  { id: "1", name: "Toronto", address: "", postalCode: "M5V", lat: 43.65, lon: -79.40 },
  { id: "2", name: "Ottawa", address: "", postalCode: "K1P", lat: 45.42, lon: -75.70 },
  { id: "3", name: "Vancouver", address: "", postalCode: "V6B", lat: 49.28, lon: -123.12 },
];
const withDist = (s) => ({ ...s, distanceKm: haversineKm(USER, s), status: "out_of_stock", url: "https://www.bestbuy.ca/x" });

function fakeApi(inStock) {
  return {
    getAllStores: vi.fn(async () => stores),
    getAvailability: vi.fn(async (_sku, ids) => new Map(ids.map((id) => [id, inStock.has(id) ? "available" : "out_of_stock"]))),
  };
}

describe("bestbuy findNearestInStock", () => {
  it("checks every store in one pass and sorts hits by distance from the user", async () => {
    const api = fakeApi(new Set(["3", "2"]));
    const res = await findNearestInStock({ sku: "1", postalCode: "M5V 3L9", nearby: [withDist(stores[0])], api, storeCoords: stores });
    expect(res.complete).toBe(true);
    expect(res.inStock.map((s) => s.id)).toEqual(["2", "3"]);
    expect(res.inStock[0].distanceKm).toBeCloseTo(haversineKm(USER, stores[1]), 0);
    expect(res.searched).toBe(3);
  });
  it("returns partial results with rateLimited on 429", async () => {
    const api = fakeApi(new Set());
    api.getAvailability.mockRejectedValue(Object.assign(new Error("429"), { code: "rate_limited" }));
    const res = await findNearestInStock({ sku: "1", postalCode: "M5V 3L9", nearby: [withDist(stores[0])], api, storeCoords: stores });
    expect(res.rateLimited).toBe(true);
    expect(res.complete).toBe(false);
  });
  it("reports noLocation when the user position cannot be estimated", async () => {
    const api = fakeApi(new Set());
    const res = await findNearestInStock({ sku: "1", postalCode: "M5V 3L9", nearby: [], api, storeCoords: stores });
    expect(res.noLocation).toBe(true);
  });
});
```

- [ ] **Step 5: Implement the search**

`src/retailers/bestbuy/search.js`:

```js
// Best Buy answers pickup availability for many stores per call, so the
// nationwide search is one pass over every store, then a sort by distance.
import { haversineKm, locateUser } from "../../lib/geo.js";

const PRODUCT_URL = (sku) => `https://www.bestbuy.ca/en-ca/product/${sku}`;

// api: { getAllStores(), getAvailability(sku, ids, postalCode) }
// storeCoords: optional pre-fetched store list (tests); otherwise api.getAllStores() is used.
export async function findNearestInStock({ sku, postalCode, nearby, checkedIds = [], onProgress, api, storeCoords }) {
  const all = storeCoords ?? await api.getAllStores();
  const coords = new Map(all.map((s) => [s.id, s]));
  const user = locateUser(nearby, coords);
  if (!user) {
    return { inStock: nearby.filter((s) => s.status === "available"), searched: nearby.length, checkedIds: nearby.map((s) => s.id), complete: false, rateLimited: false, noLocation: true };
  }
  const known = new Map(nearby.map((s) => [s.id, s.status]));
  const todo = all.filter((s) => !known.has(s.id)).map((s) => s.id);
  let rateLimited = false;
  let statuses = new Map();
  try {
    statuses = await api.getAvailability(sku, todo, postalCode);
  } catch (err) {
    if (err?.code === "rate_limited") rateLimited = true; else throw err;
  }
  const checked = new Set([...known.keys(), ...statuses.keys(), ...checkedIds]);
  onProgress?.({ calls: 1, searched: checked.size, remaining: all.length - checked.size });
  const inStock = [];
  for (const s of nearby) if (s.status === "available") inStock.push(s);
  for (const [id, status] of statuses) {
    if (status !== "available" || known.has(id)) continue;
    const c = coords.get(id);
    inStock.push({ id, name: c?.name ?? id, address: c?.address ?? "", postalCode: c?.postalCode ?? "", distanceKm: c ? haversineKm(user, c) : null, status, url: PRODUCT_URL(sku) });
  }
  inStock.sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity));
  return { inStock, searched: checked.size, checkedIds: [...checked], complete: !rateLimited, rateLimited };
}
```

If Task 5 concluded the availability endpoint is per-store only, replace this file's body with the walmart pattern: `import { findNearestInStock as probeSearch } from "../../lib/stock-search.js"` and call it with `fetchAround: (lat, lon) => api.getStoresAround(lat, lon, sku)` and `catalog: all`, exactly as `src/retailers/walmart/content.js` does.

- [ ] **Step 6: Run tests, commit**

Run: `npx vitest run` -> pass.

```bash
git add src/retailers/bestbuy/api.js src/retailers/bestbuy/search.js test/bestbuy-api.test.js test/bestbuy-search.test.js
git commit -m "feat: bestbuy client and one-pass nationwide search"
```

---

### Task 9: Best Buy content script, manifest, end-to-end check

**Files:**
- Create: `src/retailers/bestbuy/content.js`
- Modify: `src/manifest.json`, `src/retailers/walmart/content.js` (only if its `lookup` shape needs `url`), `docs/superpowers/specs/2026-09-15-multi-retailer-design.md` status line

**Interfaces:**
- Consumes: `getItem`, `getStores`, `getAvailability`, `getAllStores` from `api.js`; `findNearestInStock` from `search.js`; `rankStores` from `src/lib/rank-stores.js`; `toErrorResponse` from `src/lib/errors.js`.
- Produces: `dist/content/bestbuy.js`; manifest entry for `https://www.bestbuy.ca/*`.

- [ ] **Step 1: Write the content script**

`src/retailers/bestbuy/content.js`:

```js
// Runs on https://www.bestbuy.ca/*. Answers messages from the background worker.
import * as api from "./api.js";
import { findNearestInStock } from "./search.js";
import { rankStores } from "../../lib/rank-stores.js";
import { toErrorResponse } from "../../lib/errors.js";

const NEARBY = 10;
const STORE_CACHE_KEY = "bestbuy.stores";
const STORE_CACHE_MS = 7 * 24 * 3600 * 1000;

function reportProgress(progress) {
  chrome.runtime.sendMessage({ type: "searchProgress", ...progress }).catch(() => {});
}

async function cachedAllStores() {
  const { [STORE_CACHE_KEY]: c } = await chrome.storage.local.get(STORE_CACHE_KEY);
  if (c && Date.now() - c.at < STORE_CACHE_MS) return c.stores;
  const stores = await api.getAllStores();
  await chrome.storage.local.set({ [STORE_CACHE_KEY]: { at: Date.now(), stores } });
  return stores;
}

// Nearby stores with this sku's pickup status, nearest first.
async function lookupStores(postalCode, sku) {
  const near = (await api.getStores(postalCode)).slice(0, NEARBY);
  const status = await api.getAvailability(sku, near.map((s) => s.id), postalCode);
  return rankStores(near.map((s) => ({
    id: s.id, name: s.name, address: s.address, postalCode: s.postalCode, distanceKm: s.distanceKm,
    status: status.get(s.id) ?? "unknown", url: `https://www.bestbuy.ca/en-ca/product/${sku}`,
  })));
}

async function handle(msg) {
  switch (msg?.type) {
    case "ping":
      return { ok: true };
    case "lookup": {
      const [item, stores] = await Promise.all([api.getItem(msg.itemId), lookupStores(msg.postalCode, msg.itemId)]);
      return { ok: true, item, stores };
    }
    case "findInStock": {
      if (!Array.isArray(msg.nearby)) return { ok: false, code: "unknown", error: "findInStock needs the nearby store list." };
      const storeCoords = await cachedAllStores();
      const api2 = { ...api, getAllStores: async () => storeCoords };
      return { ok: true, ...(await findNearestInStock({ sku: msg.itemId, postalCode: msg.postalCode, nearby: msg.nearby, checkedIds: msg.checkedIds, onProgress: reportProgress, api: api2 })) };
    }
    case "selectStore":
      return { ok: false, code: "unsupported", error: "Best Buy does not support selecting a store from here; open the product page." };
    default:
      return { ok: false, code: "unknown", error: `Unknown message type: ${msg?.type}` };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handle(msg).then(sendResponse, (err) => sendResponse(toErrorResponse(err)));
  return true;
});
```

- [ ] **Step 2: Manifest**

`src/manifest.json`:

```json
"host_permissions": ["https://www.walmart.ca/*", "https://www.bestbuy.ca/*"],
"content_scripts": [
  { "matches": ["https://www.walmart.ca/*"], "js": ["content/walmart.js"], "run_at": "document_idle" },
  { "matches": ["https://www.bestbuy.ca/*"], "js": ["content/bestbuy.js"], "run_at": "document_idle" }
]
```

Also update `description` to "Find the nearest Walmart or Best Buy store that has an item in stock for pickup."

- [ ] **Step 3: Build and run everything**

Run: `npx vitest run && npm run build && ls dist/content`
Expected: tests pass; `walmart.js` and `bestbuy.js` present.

- [ ] **Step 4: End-to-end in the debug Chrome**

Load `dist/` as in Task 4 step 4, open the popup page and run three lookups with `M5V 3L9`:
1. A common Best Buy item (e.g. a DualSense controller SKU) -> nearby list with at least one "In stock", "Nearest in stock" box shows it, "Open product page" opens bestbuy.ca.
2. A scarce item (PS5 Pro SKU) -> nearby all out of stock, progress line, then either in-stock stores far away or "No Best Buy in Canada has this in stock (checked N stores)".
3. A nonsense SKU (`00000001`) -> "Item not found."

Record the outcome (including any rate-limit behaviour) in `docs/bestbuy-ca-endpoints.md`.

- [ ] **Step 5: Update the spec status and commit**

Change the spec's `Status:` line to "implemented for walmart + bestbuy on <date>; staples/shoppers/gamestop pending discovery".

```bash
git add -A
git commit -m "feat: bestbuy adapter (content script, manifest) and multi-retailer manifest"
```

---

### Task 10: Documentation

**Files:**
- Modify: `docs/walmart-ca-endpoints.md` (paths already updated in Task 2), `docs/superpowers/specs/2026-09-15-walmart-ca-pickup-finder-design.md` (component table paths)
- Create: `README.md`

- [ ] **Step 1: README**

```markdown
# Pickup Finder (walmart.ca, bestbuy.ca)

Chrome extension. Paste a product URL and a Canadian postal code; it lists the
nearest stores of that retailer with pickup status and then searches the whole
country for the nearest store that has the item in stock.

Build: `npm install && npm run build`, then load `dist/` unpacked in Chrome.
Tests: `npm test`.

Adding a retailer: create `src/retailers/<name>/{urls.js,content.js}` (see
`bestbuy/` for the smallest example), register `urls.js` in
`src/retailers/index.js`, add the host to `src/manifest.json`, and document the
endpoints in `docs/<name>-endpoints.md`. Design: `docs/superpowers/specs/`.
```

- [ ] **Step 2: Fix paths in the original walmart spec's component table**

In `docs/superpowers/specs/2026-09-15-walmart-ca-pickup-finder-design.md` replace `content/index.js` -> `retailers/walmart/content.js`, `content/walmart-api.js` -> `retailers/walmart/api.js`, `lib/parse-walmart.js` -> `retailers/walmart/parse.js`, `lib/parse-item-id.js` -> `retailers/walmart/urls.js`.

- [ ] **Step 3: Commit**

```bash
git add README.md docs
git commit -m "docs: readme and updated paths for the retailer layout"
```

---

## Self-review

- Spec coverage: input/URL detection (Tasks 1, 4, 6), adapter interface (Tasks 2, 9), background routing (Task 3), manifest/build per retailer (Tasks 2, 9), popup changes (Task 4), Best Buy discovery + adapter (Tasks 5-9), error codes incl. `unsupported` (Task 3), testing (each task + Task 9 e2e), docs (Task 10). Out-of-scope items untouched.
- Placeholders: Task 5 is a discovery task by design; Tasks 7-9 name the expected fields and state that the discovery doc overrides them. No "TBD".
- Type consistency: `parseProductUrl` (adapter: `string|null`; registry: `{retailer,itemId}|null`), `SearchResult` fields, `Store.url`, message `retailer` field, `handle(msg, deps)` consistent across tasks.
