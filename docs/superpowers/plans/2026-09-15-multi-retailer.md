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
- Consumes: `docs/bestbuy-ca-endpoints.md` (authoritative field names) and the fixtures `test/fixtures/bestbuy-product.json` (catalog query response), `bestbuy-stores.json` (`/api/v3/json/locations` response), `bestbuy-availability.json` (`/ecomm-api/availability/products` response).
- Produces: `parseProduct(json) -> Item`, `parseStores(json) -> Array<{ id, name, address, postalCode, lat, lon, distanceKm }>`, `parseAvailability(json) -> { aggregate: string, statuses: Map<locationId, "available"|"out_of_stock"|"unknown"> }`.

- [ ] **Step 1: Write the failing tests against the fixtures**

`test/bestbuy-parse.test.js`:

```js
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseProduct, parseStores, parseAvailability } from "../src/retailers/bestbuy/parse.js";

const load = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8"));

describe("bestbuy parsers", () => {
  it("parseProduct maps the catalog item", () => {
    const item = parseProduct(load("bestbuy-product.json"));
    expect(item.retailer).toBe("bestbuy");
    expect(item.id).toMatch(/^\d+$/);
    expect(item.name.length).toBeGreaterThan(3);
    expect(item.url).toMatch(/^https:\/\/www\.bestbuy\.ca\/en-ca\/product\//i);
    expect(item.priceString).toMatch(/^\$\d+\.\d{2}$/);
    expect(item.imageUrl).toMatch(/^https:\/\//);
  });
  it("parseProduct throws not_found when the catalog has no items", () => {
    expect(() => parseProduct({ currentPage: 1, total: 0, totalPages: 1, pageSize: 20, items: [] }))
      .toThrow(expect.objectContaining({ code: "not_found" }));
  });
  it("parseProduct throws api_changed on an unexpected shape", () => {
    expect(() => parseProduct({ foo: 1 })).toThrow(expect.objectContaining({ code: "api_changed" }));
  });
  it("parseStores maps id, address, coordinates and distance", () => {
    const stores = parseStores(load("bestbuy-stores.json"));
    expect(stores.length).toBeGreaterThan(0);
    for (const s of stores) {
      expect(s.id).toMatch(/^\d+$/);
      expect(typeof s.lat).toBe("number");
      expect(typeof s.lon).toBe("number");
      expect(s.address).toContain(s.postalCode);
      expect(typeof s.distanceKm).toBe("number");
    }
  });
  it("parseStores returns an empty list for an unrecognised postal code", () => {
    expect(parseStores({ Brand: "BestBuyCanada", currentPage: 0, pageSize: 0, totalPages: 0, total: 0, locations: [] })).toEqual([]);
  });
  it("parseAvailability maps hasInventory / supportsFulfillment per location and keeps the aggregate", () => {
    const { aggregate, statuses } = parseAvailability(load("bestbuy-availability.json"));
    expect(typeof aggregate).toBe("string");
    expect(statuses.size).toBeGreaterThan(0);
    for (const status of statuses.values()) expect(["available", "out_of_stock", "unknown"]).toContain(status);
  });
  it("parseAvailability applies the documented mapping", () => {
    const json = { availabilities: [{ sku: "1", pickup: { status: "InStock", locations: [
      { locationKey: "1", hasInventory: true, quantityOnHand: 3, supportsFulfillment: true },
      { locationKey: "2", hasInventory: false, quantityOnHand: 0, supportsFulfillment: true },
      { locationKey: "3", hasInventory: false, quantityOnHand: 0, supportsFulfillment: false },
    ] } }] };
    const { statuses } = parseAvailability(json);
    expect([...statuses]).toEqual([["1", "available"], ["2", "out_of_stock"], ["3", "unknown"]]);
  });
  it("parseAvailability throws api_changed when availabilities is missing", () => {
    expect(() => parseAvailability({})).toThrow(expect.objectContaining({ code: "api_changed" }));
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/bestbuy-parse.test.js` -> FAIL (module missing).

- [ ] **Step 3: Implement**

`src/retailers/bestbuy/parse.js`:

```js
// Pure parsers for bestbuy.ca responses. Field names: docs/bestbuy-ca-endpoints.md
import { WalmartApiError, apiChanged } from "../../lib/errors.js";

const ORIGIN = "https://www.bestbuy.ca";

// /api/v1/catalog/query response -> Item. total 0 / no items = unknown SKU.
export function parseProduct(json) {
  if (!json || typeof json !== "object" || !Array.isArray(json.items)) throw apiChanged(JSON.stringify(json));
  const p = json.items[0];
  if (!p) throw new WalmartApiError("not_found");
  if (!p.sku || !p.name) throw apiChanged(JSON.stringify(json));
  const price = p.salePrice ?? p.regularPrice;
  const path = typeof p.productUrl === "string" && p.productUrl.startsWith("/") ? p.productUrl.replace(/^\/en-CA\//, "/en-ca/") : `/en-ca/product/${p.sku}`;
  return {
    id: String(p.sku),
    name: String(p.name),
    priceString: Number.isFinite(Number(price)) ? `$${Number(price).toFixed(2)}` : "",
    imageUrl: p.thumbnailImage ? String(p.thumbnailImage) : null,
    url: ORIGIN + path,
    retailer: "bestbuy",
  };
}

// /api/v3/json/locations response -> stores with coordinates (no availability).
export function parseStores(json) {
  const list = json?.locations;
  if (!Array.isArray(list)) throw apiChanged(JSON.stringify(json));
  return list.map((s) => ({
    id: String(s.locationId ?? ""),
    name: String(s.name ?? ""),
    address: [s.address1, [s.city, [s.region, s.postalCode].filter(Boolean).join(" ")].filter(Boolean).join(", ")].filter(Boolean).join(", "),
    postalCode: String(s.postalCode ?? ""),
    lat: Number(s.lat),
    lon: Number(s.lng),
    distanceKm: Number.isFinite(Number(s.distance)) ? Number(s.distance) : null,
  }));
}

// /ecomm-api/availability/products response (one SKU) -> per-location statuses.
// hasInventory true -> available; false with supportsFulfillment -> out_of_stock; otherwise unknown.
// Locations the service does not carry are absent from the response: callers treat missing ids as unknown.
export function parseAvailability(json) {
  const a = json?.availabilities?.[0];
  if (!a || !a.pickup || !Array.isArray(a.pickup.locations)) throw apiChanged(JSON.stringify(json));
  const statuses = new Map();
  for (const l of a.pickup.locations) {
    const status = l.hasInventory === true ? "available" : l.supportsFulfillment === true ? "out_of_stock" : "unknown";
    statuses.set(String(l.locationKey), status);
  }
  return { aggregate: String(a.pickup.status ?? ""), statuses };
}
```

- [ ] **Step 4: Run tests, commit**

Run: `npx vitest run` -> pass.

```bash
git add src/retailers/bestbuy/parse.js test/bestbuy-parse.test.js
git commit -m "feat: bestbuy parsers"
```

---

### Task 8: Best Buy client, store list and nationwide search

**Files:**
- Create: `src/retailers/bestbuy/api.js`
- Create: `src/retailers/bestbuy/search.js`
- Create: `tools/build-bestbuy-stores.mjs`
- Create: `src/retailers/bestbuy/stores-ca.json` (generated by the tool)
- Create: `test/bestbuy-api.test.js`, `test/bestbuy-search.test.js`

**Interfaces:**
- Consumes: parsers from Task 7; `haversineKm`, `locateUser` from `src/lib/geo.js`; `WalmartApiError`, `apiChanged` from `src/lib/errors.js`.
- Produces: `api.js` exporting `buildProductUrl(sku)`, `buildStoresUrl(postalCode)`, `buildAvailabilityUrl(sku, locationIds)`, `getItem(sku) -> Item`, `getStores(postalCode) -> parsed stores near the postal code`, `getAvailability(sku, locationIds) -> { aggregate, statuses }` (one call; caller batches), `LOCATIONS_PER_CALL = 90`. `search.js` exporting `findNearestInStock({ sku, nearby, checkedIds, onProgress, api, catalog, gapMs }) -> SearchResult`. `stores-ca.json` shaped `{ generatedAt, stores: [{ id, name, address, postalCode, lat, lon }] }`.

- [ ] **Step 1: Write the failing client test**

`test/bestbuy-api.test.js`:

```js
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { getItem, getStores, getAvailability, buildAvailabilityUrl, buildStoresUrl, buildProductUrl, LOCATIONS_PER_CALL } from "../src/retailers/bestbuy/api.js";

const fx = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8");
const jsonResponse = (body, status = 200) => new Response(body, { status, headers: { "content-type": "application/json" } });

describe("bestbuy request builders", () => {
  it("buildAvailabilityUrl sends the standardproduct accept parameter, pipe-joined locations and the sku", () => {
    const url = new URL(buildAvailabilityUrl("19446111", ["927", "196"]));
    expect(url.origin + url.pathname).toBe("https://www.bestbuy.ca/ecomm-api/availability/products");
    expect(url.searchParams.get("accept")).toBe("application/vnd.bestbuy.standardproduct.v1+json");
    expect(url.searchParams.get("accept-language")).toBe("en-CA");
    expect(url.searchParams.get("locations")).toBe("927|196");
    expect(url.searchParams.get("skus")).toBe("19446111");
    expect(url.searchParams.has("postalCode")).toBe(false);
  });
  it("buildStoresUrl asks for everything in range in one page", () => {
    const url = new URL(buildStoresUrl("M5V 3L9"));
    expect(url.pathname).toBe("/api/v3/json/locations");
    expect(url.searchParams.get("postalCode")).toBe("M5V 3L9");
    expect(url.searchParams.get("pageSize")).toBe("1000");
    expect(url.searchParams.get("lang")).toBe("en-CA");
  });
  it("buildProductUrl queries the catalog by id", () => {
    const url = new URL(buildProductUrl("19446111"));
    expect(url.pathname).toBe("/api/v1/catalog/query");
    expect(url.searchParams.get("ids")).toBe("19446111");
    expect(url.searchParams.get("lang")).toBe("en-CA");
  });
  it("LOCATIONS_PER_CALL stays under the measured 96 ceiling", () => {
    expect(LOCATIONS_PER_CALL).toBeLessThanOrEqual(96);
  });
});

describe("bestbuy fetching", () => {
  let fetchMock;
  beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock); });
  afterEach(() => vi.unstubAllGlobals());

  it("getAvailability parses statuses", async () => {
    fetchMock.mockResolvedValue(jsonResponse(fx("bestbuy-availability.json")));
    const { statuses } = await getAvailability("19446111", ["927"]);
    expect(statuses.size).toBeGreaterThan(0);
  });
  it("getAvailability refuses more ids than one call accepts", async () => {
    await expect(getAvailability("1", Array.from({ length: LOCATIONS_PER_CALL + 1 }, (_, i) => String(i)))).rejects.toThrow(/locations/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("getItem parses the product", async () => {
    fetchMock.mockResolvedValue(jsonResponse(fx("bestbuy-product.json")));
    expect((await getItem("19446111")).retailer).toBe("bestbuy");
  });
  it("getStores parses the locator", async () => {
    fetchMock.mockResolvedValue(jsonResponse(fx("bestbuy-stores.json")));
    expect((await getStores("M5V 3L9")).length).toBeGreaterThan(0);
  });
  it("maps HTML/403 to verification, 429 to rate_limited, other non-2xx JSON to api_changed", async () => {
    fetchMock.mockResolvedValueOnce(new Response("<html>", { status: 403, headers: { "content-type": "text/html" } }));
    await expect(getItem("1")).rejects.toMatchObject({ code: "verification" });
    fetchMock.mockResolvedValueOnce(new Response("", { status: 429 }));
    await expect(getItem("1")).rejects.toMatchObject({ code: "rate_limited" });
    fetchMock.mockResolvedValueOnce(jsonResponse('{"errorCode":"1103","errorMessage":"Invalid query parameter"}', 400));
    await expect(getItem("1")).rejects.toMatchObject({ code: "api_changed" });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/bestbuy-api.test.js` -> FAIL (module missing).

- [ ] **Step 3: Implement the client**

`src/retailers/bestbuy/api.js`:

```js
// bestbuy.ca REST endpoints. No cookies, headers or hashes are needed (docs/bestbuy-ca-endpoints.md),
// but the calls still run from the bestbuy.ca content script so every retailer works the same way.
import { parseProduct, parseStores, parseAvailability } from "./parse.js";
import { WalmartApiError, apiChanged } from "../../lib/errors.js";

const ORIGIN = "https://www.bestbuy.ca";
// The gateway accepts up to 96 ids per call (97 was rejected upstream); keep headroom.
export const LOCATIONS_PER_CALL = 90;

export function buildProductUrl(sku) {
  return `${ORIGIN}/api/v1/catalog/query?${new URLSearchParams({ ids: String(sku), lang: "en-CA" })}`;
}

export function buildStoresUrl(postalCode) {
  return `${ORIGIN}/api/v3/json/locations?${new URLSearchParams({ lang: "en-CA", postalCode, pageSize: "1000" })}`;
}

// The `accept` media type is a query parameter here, not a header; without it the
// response has no per-store locations.
export function buildAvailabilityUrl(sku, locationIds) {
  const q = new URLSearchParams({
    accept: "application/vnd.bestbuy.standardproduct.v1+json",
    "accept-language": "en-CA",
    locations: locationIds.join("|"),
    skus: String(sku),
  });
  return `${ORIGIN}/ecomm-api/availability/products?${q}`;
}

async function get(url) {
  const res = await globalThis.fetch(url, { credentials: "omit", headers: { accept: "application/json" } });
  const text = await res.text();
  const contentType = res.headers.get("content-type") ?? "";
  if (res.status === 403 || /text\/html/i.test(contentType) || /^\s*</.test(text)) throw new WalmartApiError("verification");
  if (res.status === 429) throw new WalmartApiError("rate_limited");
  let json;
  try { json = JSON.parse(text); } catch { throw apiChanged(text); }
  if (!res.ok) throw apiChanged(text);
  return json;
}

export async function getItem(sku) { return parseProduct(await get(buildProductUrl(sku))); }
export async function getStores(postalCode) { return parseStores(await get(buildStoresUrl(postalCode))); }

// One availability call; callers batch ids in chunks of LOCATIONS_PER_CALL.
export async function getAvailability(sku, locationIds) {
  if (locationIds.length > LOCATIONS_PER_CALL) throw new Error(`getAvailability: at most ${LOCATIONS_PER_CALL} locations per call`);
  return parseAvailability(await get(buildAvailabilityUrl(sku, locationIds)));
}
```

- [ ] **Step 4: Write the failing search test**

`test/bestbuy-search.test.js`:

```js
import { describe, it, expect, vi } from "vitest";
import { findNearestInStock } from "../src/retailers/bestbuy/search.js";
import { haversineKm } from "../src/lib/geo.js";

const USER = { lat: 43.64, lon: -79.39 };
const catalog = [
  { id: "1", name: "Toronto", address: "A", postalCode: "M5V 3L9", lat: 43.65, lon: -79.40 },
  { id: "2", name: "Ottawa", address: "B", postalCode: "K1P 1J1", lat: 45.42, lon: -75.70 },
  { id: "3", name: "Vancouver", address: "C", postalCode: "V6B 1A1", lat: 49.28, lon: -123.12 },
  { id: "4", name: "Halifax", address: "D", postalCode: "B3J 1S9", lat: 44.65, lon: -63.58 },
];
const near = (s, status = "out_of_stock") => ({ ...s, distanceKm: haversineKm(USER, s), status, url: "https://www.bestbuy.ca/x" });

function fakeApi(inStock, { aggregate = "OutOfStock", perCall = 2 } = {}) {
  return {
    LOCATIONS_PER_CALL: perCall,
    getAvailability: vi.fn(async (_sku, ids) => ({
      aggregate, statuses: new Map(ids.map((id) => [id, inStock.has(id) ? "available" : "out_of_stock"])),
    })),
  };
}

describe("bestbuy findNearestInStock", () => {
  it("returns nearby in-stock stores without any call when one is already available", async () => {
    const api = fakeApi(new Set());
    const res = await findNearestInStock({ sku: "1", nearby: [near(catalog[0], "available")], api, catalog });
    expect(api.getAvailability).not.toHaveBeenCalled();
    expect(res.inStock.map((s) => s.id)).toEqual(["1"]);
    expect(res.complete).toBe(true);
  });
  it("checks the remaining stores nearest-first in batches and stops at the first batch with a hit", async () => {
    const api = fakeApi(new Set(["3", "4"]), { perCall: 1 });
    const progress = vi.fn();
    const res = await findNearestInStock({ sku: "1", nearby: [near(catalog[0])], api, catalog, onProgress: progress });
    // Order by distance from Toronto: Ottawa (2), Halifax (4), Vancouver (3) -> two calls, stop at Halifax.
    expect(api.getAvailability.mock.calls.map((c) => c[1])).toEqual([["2"], ["4"]]);
    expect(res.inStock.map((s) => s.id)).toEqual(["4"]);
    expect(res.inStock[0].distanceKm).toBeCloseTo(haversineKm(USER, catalog[3]), 0);
    expect(res.inStock[0].url).toBe("https://www.bestbuy.ca/en-ca/product/1");
    expect(res.complete).toBe(true);
    expect(res.searched).toBe(3);
    expect(new Set(res.checkedIds)).toEqual(new Set(["1", "2", "4"]));
    expect(progress).toHaveBeenCalled();
  });
  it("reports a complete, empty search when nothing is in stock anywhere", async () => {
    const api = fakeApi(new Set(), { perCall: 3 });
    const res = await findNearestInStock({ sku: "1", nearby: [near(catalog[0])], api, catalog });
    expect(res.inStock).toEqual([]);
    expect(res.complete).toBe(true);
    expect(res.searched).toBe(4);
  });
  it("short-circuits when the aggregate says the item is never sold in stores", async () => {
    const api = fakeApi(new Set(), { aggregate: "OnlineOnly", perCall: 1 });
    const res = await findNearestInStock({ sku: "1", nearby: [near(catalog[0])], api, catalog });
    expect(api.getAvailability).toHaveBeenCalledTimes(1);
    expect(res.complete).toBe(true);
    expect(res.inStock).toEqual([]);
  });
  it("treats ids missing from a response as unknown and still counts them as checked", async () => {
    const api = fakeApi(new Set(), { perCall: 3 });
    api.getAvailability.mockResolvedValueOnce({ aggregate: "OutOfStock", statuses: new Map([["2", "out_of_stock"]]) });
    const res = await findNearestInStock({ sku: "1", nearby: [near(catalog[0])], api, catalog });
    expect(res.searched).toBe(4);
    expect(res.complete).toBe(true);
  });
  it("returns partial results with rateLimited on 429", async () => {
    const api = fakeApi(new Set(), { perCall: 1 });
    api.getAvailability.mockRejectedValueOnce(Object.assign(new Error("429"), { code: "rate_limited" }));
    const res = await findNearestInStock({ sku: "1", nearby: [near(catalog[0])], api, catalog });
    expect(res.rateLimited).toBe(true);
    expect(res.complete).toBe(false);
  });
  it("skips ids already checked in an earlier round", async () => {
    const api = fakeApi(new Set(), { perCall: 3 });
    await findNearestInStock({ sku: "1", nearby: [near(catalog[0])], checkedIds: ["2", "3"], api, catalog });
    expect(api.getAvailability.mock.calls[0][1]).toEqual(["4"]);
  });
  it("reports noLocation when the user position cannot be estimated", async () => {
    const api = fakeApi(new Set());
    const res = await findNearestInStock({ sku: "1", nearby: [], api, catalog });
    expect(res.noLocation).toBe(true);
    expect(api.getAvailability).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 5: Implement the search**

`src/retailers/bestbuy/search.js`:

```js
// Best Buy answers pickup availability for up to LOCATIONS_PER_CALL stores per call,
// so the nationwide search is a nearest-first sweep over the store catalog in a
// handful of batches, stopping at the first batch that contains stock.
import { haversineKm, locateUser } from "../../lib/geo.js";

const PRODUCT_URL = (sku) => `https://www.bestbuy.ca/en-ca/product/${sku}`;
const NEVER_IN_STORE = new Set(["OnlineOnly", "NotAvailable"]);

// api: { LOCATIONS_PER_CALL, getAvailability(sku, ids) -> { aggregate, statuses } }
// catalog: [{ id, name, address, postalCode, lat, lon }] — every store in Canada.
export async function findNearestInStock({ sku, nearby, checkedIds = [], onProgress, api, catalog, gapMs = 0 }) {
  const coords = new Map(catalog.map((s) => [s.id, s]));
  const inStock = nearby.filter((s) => s.status === "available");
  const checked = new Set([...nearby.map((s) => s.id), ...checkedIds]);
  const done = (complete, rateLimited = false) => ({
    inStock: inStock.sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity)),
    searched: checked.size, checkedIds: [...checked], complete, rateLimited,
  });
  if (inStock.length) return done(true);
  const user = locateUser(nearby, coords);
  if (!user) return { ...done(false), noLocation: true };

  const todo = catalog
    .filter((s) => !checked.has(s.id))
    .map((s) => ({ s, km: haversineKm(user, s) }))
    .sort((a, b) => a.km - b.km);
  for (let i = 0; i < todo.length; i += api.LOCATIONS_PER_CALL) {
    const batch = todo.slice(i, i + api.LOCATIONS_PER_CALL);
    let result;
    try {
      if (gapMs && i) await new Promise((r) => setTimeout(r, gapMs));
      result = await api.getAvailability(sku, batch.map(({ s }) => s.id));
    } catch (err) {
      if (err?.code === "rate_limited") return done(false, true);
      throw err;
    }
    for (const { s, km } of batch) {
      checked.add(s.id); // ids the service does not carry are absent from the response: unknown, but checked
      if (result.statuses.get(s.id) === "available") {
        inStock.push({ id: s.id, name: s.name, address: s.address, postalCode: s.postalCode, distanceKm: km, status: "available", url: PRODUCT_URL(sku) });
      }
    }
    onProgress?.({ calls: i / api.LOCATIONS_PER_CALL + 1, searched: checked.size, remaining: todo.length - i - batch.length });
    if (inStock.length || NEVER_IN_STORE.has(result.aggregate)) break;
  }
  return done(true);
}
```

- [ ] **Step 6: Run tests**

Run: `npx vitest run` -> pass.

- [ ] **Step 7: Build the store list**

`tools/build-bestbuy-stores.mjs` (plain Node; the endpoint needs no cookies):

```js
// Dev-only. Builds src/retailers/bestbuy/stores-ca.json by sweeping
// /api/v3/json/locations (fixed ~50 km radius around a postal code) over seed
// postal codes across Canada and de-duplicating on locationId.
//   node tools/build-bestbuy-stores.mjs
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildStoresUrl } from "../src/retailers/bestbuy/api.js";
import { parseStores } from "../src/retailers/bestbuy/parse.js";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "retailers", "bestbuy", "stores-ca.json");
const GAP_MS = 1000;
// One postal code per metro / region; the locator's radius is ~50 km so neighbouring seeds overlap.
const SEEDS = [
  "M5V 3L9", "L4T 9Z0", "L6Y 4R9", "L1H 7K5", "L3R 9W3", "L7L 6J8", "L8P 4S3", "L2R 7K6", "N2G 4X6", "N6A 3N7", "N9A 6K3", "N7T 7Y7",
  "L4M 1A1", "K7L 5C3", "K8N 3A5", "K1P 1J1", "K2C 3P4", "P3E 3K9", "P7B 5E1", "P4N 2K7", "P6A 1Y9", "P1B 2H3", "N1H 3A4", "N8X 1J3",
  "H2Y 1C6", "H4T 1E7", "J4K 5G4", "J7Y 4V2", "G1R 4P5", "G6V 8N6", "J1H 5H9", "G8Z 3G7", "J2S 2M2", "G7H 5B8", "G9A 5J3", "J8X 2A2", "J9X 5V7", "G4R 4K3",
  "V6B 1A1", "V3M 1A7", "V5H 4M1", "V2X 2P2", "V3T 2W2", "V9A 1A2", "V9R 5S5", "V1Y 6M6", "V2C 1X2", "V2A 5L6", "V1L 4E3", "V2L 3G1", "V8J 1P4", "V9N 2L4", "V1A 2A9",
  "T2P 1J9", "T3K 5P4", "T5J 0N3", "T6E 5V5", "T4N 3T7", "T1K 2R3", "T1Y 1H6", "T9H 1T6", "T8V 2Z9", "T1H 4A1", "T9E 6Z7", "T8N 4B5",
  "S7K 0J5", "S4P 3Y2", "S6H 4H3", "S9A 2H5", "S6V 5T2",
  "R3C 0V8", "R7A 0A1", "R8N 0Y5",
  "B3J 1S9", "B2Y 3Y8", "B4A 3Y7", "B1P 6J7", "B4N 3E8", "B2N 5B7",
  "E1C 1B4", "E2L 4L1", "E3B 5H1", "E2A 1V3", "E7M 2Z3", "C1A 1A1",
  "A1B 3X5", "A2H 6J8", "A1V 1W3", "A2A 2K3", "A2N 2X5",
  "Y1A 1A1", "X1A 2N1", "X0E 0T0",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stores = new Map();
for (const [i, seed] of SEEDS.entries()) {
  const res = await fetch(buildStoresUrl(seed));
  if (!res.ok) { console.log(`${seed}: HTTP ${res.status}`); continue; }
  const list = parseStores(await res.json());
  let added = 0;
  for (const s of list) if (!stores.has(s.id)) { stores.set(s.id, { id: s.id, name: s.name, address: s.address, postalCode: s.postalCode, lat: s.lat, lon: s.lon }); added++; }
  console.log(`${i + 1}/${SEEDS.length} ${seed}: ${list.length} in range, ${added} new, ${stores.size} total`);
  await sleep(GAP_MS);
}
const list = [...stores.values()].sort((a, b) => a.id.localeCompare(b.id));
writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), stores: list }));
console.log(`done: ${list.length} stores -> ${OUT}`);
```

Run: `node tools/build-bestbuy-stores.mjs`. Expected: a few hundred stores (the directory sitemap lists 315; a sweep of these seeds should land within ~10% of that — if it finds far fewer, add seeds for the regions that are missing and re-run). Sanity-check: `node -e "const j=require('./src/retailers/bestbuy/stores-ca.json');console.log(j.stores.length, j.stores.filter(s=>!Number.isFinite(s.lat)).length)"` -> second number must be 0.

- [ ] **Step 8: Commit**

```bash
git add src/retailers/bestbuy/api.js src/retailers/bestbuy/search.js src/retailers/bestbuy/stores-ca.json tools/build-bestbuy-stores.mjs test/bestbuy-api.test.js test/bestbuy-search.test.js
git commit -m "feat: bestbuy client, store list and nearest-first batched search"
```

---

### Task 9: Best Buy content script, manifest, end-to-end check

**Files:**
- Create: `src/retailers/bestbuy/content.js`
- Modify: `src/manifest.json`, `docs/superpowers/specs/2026-09-15-multi-retailer-design.md` (status line), `docs/bestbuy-ca-endpoints.md` (e2e outcome)

**Interfaces:**
- Consumes: `api.js` (`getItem`, `getStores`, `getAvailability`, `LOCATIONS_PER_CALL`), `search.js` (`findNearestInStock`), `stores-ca.json`, `rankStores` from `src/lib/rank-stores.js`, `toErrorResponse` from `src/lib/errors.js`.
- Produces: `dist/content/bestbuy.js`; manifest entry for `https://www.bestbuy.ca/*`; message handling identical in shape to the walmart content script (`ping`, `lookup`, `findInStock`, `selectStore` -> unsupported).

- [ ] **Step 1: Write the content script**

`src/retailers/bestbuy/content.js`:

```js
// Runs on https://www.bestbuy.ca/*. Answers messages from the background worker.
import * as api from "./api.js";
import { findNearestInStock } from "./search.js";
import catalog from "./stores-ca.json";
import { rankStores } from "../../lib/rank-stores.js";
import { toErrorResponse } from "../../lib/errors.js";

const NEARBY = 10;
const SEARCH_GAP_MS = 1000;
const PRODUCT_URL = (sku) => `https://www.bestbuy.ca/en-ca/product/${sku}`;

function reportProgress(progress) {
  chrome.runtime.sendMessage({ type: "searchProgress", ...progress }).catch(() => {});
}

// The nearest stores to the postal code with this sku's pickup status.
async function lookupStores(postalCode, sku) {
  const near = (await api.getStores(postalCode)).slice(0, NEARBY);
  if (!near.length) return [];
  const { statuses } = await api.getAvailability(sku, near.map((s) => s.id));
  return rankStores(near.map((s) => ({
    id: s.id, name: s.name, address: s.address, postalCode: s.postalCode, distanceKm: s.distanceKm,
    status: statuses.get(s.id) ?? "unknown", url: PRODUCT_URL(sku),
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
      const result = await findNearestInStock({
        sku: msg.itemId, nearby: msg.nearby, checkedIds: msg.checkedIds ?? [],
        onProgress: reportProgress, api, catalog: catalog.stores, gapMs: SEARCH_GAP_MS,
      });
      return { ok: true, ...result };
    }
    case "selectStore":
      return { ok: false, code: "unsupported", error: "Best Buy does not support selecting a store from here; open the product page instead." };
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
"description": "Find the nearest Walmart or Best Buy store that has an item in stock for pickup.",
"host_permissions": ["https://www.walmart.ca/*", "https://www.bestbuy.ca/*"],
"content_scripts": [
  { "matches": ["https://www.walmart.ca/*"], "js": ["content/walmart.js"], "run_at": "document_idle" },
  { "matches": ["https://www.bestbuy.ca/*"], "js": ["content/bestbuy.js"], "run_at": "document_idle" }
]
```

(`name` may become "Pickup Finder (Walmart, Best Buy)"; the popup `<title>` likewise.)

- [ ] **Step 2b: Retailer-neutral popup copy**

In `src/popup/popup.js` `renderNearest`, the three messages that name Walmart must use the current retailer's label and host instead. Replace them with:

```js
  const label = RETAILERS[state.retailer]?.label ?? "This store";
  const host = RETAILERS[state.retailer]?.host ?? "the site";
  if (res.noLocation) text = "Could not work out where you are relative to the store list, so only nearby stores were checked.";
  else if (res.rateLimited) text = `${host} rate-limited the search after ${res.searched} stores. Wait a minute or two, then keep searching.`;
  else if (!state.inStock.length && res.complete) text = `No ${label} in Canada has this in stock for pickup (checked ${res.searched} stores).`;
```

(the remaining two branches are unchanged.) Add `src/popup/popup.js` to the commit.

- [ ] **Step 3: Build and run everything**

Run: `npx vitest run && npm run build && ls dist/content`
Expected: tests pass; `walmart.js` and `bestbuy.js` present.

- [ ] **Step 4: End-to-end in a debug Chrome**

Launch a scratch-profile Chrome with `--remote-debugging-port=9223 --enable-unsafe-extension-debugging --user-data-dir=<scratch dir> https://www.bestbuy.ca/en-ca`, load `dist/` with the DevTools `Extensions.loadUnpacked` command (a `loadext.mjs` helper may exist in the session scratchpad; otherwise: connect to `http://127.0.0.1:9223/json/version`'s `webSocketDebuggerUrl`, send `{"id":1,"method":"Extensions.loadUnpacked","params":{"path":"C:/Users/hmai/Desktop/opencv/walmart/dist"}}`), open `chrome-extension://<id>/popup/popup.html` in a tab and drive it (an `e2e.mjs` helper may exist; otherwise set the two inputs and `requestSubmit()` via `Runtime.evaluate`, then read `document.body.innerText` after ~20 s). Three lookups with `M5V 3L9`:
1. `https://www.bestbuy.ca/en-ca/product/x/19491570` (DualSense controller) -> nearby list with at least one "In stock", "Nearest in stock" box, "Open product page" button opens bestbuy.ca.
2. `https://www.bestbuy.ca/en-ca/product/x/19446111` (PS5 Slim) -> nearby list; if all out of stock, progress line then either far in-stock stores or "No Best Buy in Canada has this in stock (checked N stores)".
3. `https://www.bestbuy.ca/en-ca/product/x/99999999` -> "Item not found."

Record the outcome in a short "End-to-end check" section at the end of `docs/bestbuy-ca-endpoints.md`. Close the Chrome you launched.

- [ ] **Step 5: Update the spec status and commit**

Change the spec's `Status:` line to "implemented for walmart + bestbuy on 2026-09-15; staples/shoppers/gamestop pending discovery".

```bash
git add src/retailers/bestbuy/content.js src/manifest.json src/popup/popup.html docs/bestbuy-ca-endpoints.md docs/superpowers/specs/2026-09-15-multi-retailer-design.md
git commit -m "feat: bestbuy adapter content script and multi-retailer manifest"
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
