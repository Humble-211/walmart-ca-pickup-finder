# Multi-Retailer Pickup Finder — Design

Date: 2026-09-15
Status: implemented for walmart + bestbuy on 2026-09-15; staples/shoppers/gamestop pending discovery
Builds on: `2026-09-15-walmart-ca-pickup-finder-design.md`

## Goal

Extend the extension so the user can paste a product URL from walmart.ca,
bestbuy.ca, staples.ca, shoppersdrugmart.ca or gamestop.ca (ebgames.ca now
redirects there) plus a postal code, and get the nearest store of that
retailer that has the item in stock, however far away it is. Same UI and flow
as today: nearby list first, then an automatic nationwide search when nothing
nearby has stock.

This spec covers the retailer-adapter framework, moving Walmart onto it, and
the first new retailer, Best Buy. Staples, Shoppers and GameStop each get a
later discovery + implementation round on the same framework.

## Decisions (from brainstorming)

- Product input is a pasted product URL; the retailer is detected from it.
  A bare item ID still means Walmart. No keyword search, no cross-retailer
  matching of the "same" product.
- One retailer at a time, Best Buy first.
- For non-Walmart retailers a store row only opens the product page; no
  attempt to pre-select the store. Walmart keeps its "Order pickup" action.
- One extension, one adapter directory per retailer. Separate extensions or a
  server were rejected (every site blocks non-browser traffic).

## Constraints

- Every retailer only answers its internal store-stock endpoints from a page
  on its own domain (cookies, bot protection). Each retailer therefore has its
  own content script and its own tab, exactly like walmart.ca today.
- Endpoints are undocumented. Each retailer starts with a discovery round
  (Chrome debug + `tools/capture.js` / `tools/eval.js`) recorded in
  `docs/<retailer>-endpoints.md` with real fixtures. Discovery may show a site
  is not feasible; that is reported, not forced.
- "Nearest in stock nationwide" is retailer-specific. walmart.ca returns at
  most 50 stores within 100 km per call and rate-limits hard, so it probes
  outward (`lib/stock-search.js`). Best Buy is expected to answer stock for
  many stores in one call, so its search is one batched pass. The adapter
  decides; the popup only sees the shared result shape.

## Architecture

```
popup
  parseProductUrl(input) -> { retailer, itemId }      (src/retailers/index.js, no network)
  sendMessage({ type, retailer, ... })
     v
background
  adapter = RETAILERS[retailer]; find/open tab on adapter.host, wait for ping
  forward message to that tab
     v
content script for that retailer (src/retailers/<name>/content.js)
  getItem, findStores, findInStock (+ selectStore for walmart)
  streams { type: "searchProgress" } back to the popup
     v
popup renders Item, nearby Store[], in-stock Store[]
```

## Shared types

```
Item  { id, name, priceString, imageUrl, url, retailer }
Store { id, name, address, postalCode, distanceKm | null,
        status: "available" | "out_of_stock" | "unknown",
        url,                      // product page for this store (retailer-specific; may equal item.url)
        accessPointId?: string }  // walmart only, for setPickup
SearchResult { inStock: Store[], searched: number, checkedIds: string[],
               complete: boolean, rateLimited: boolean, noLocation?: boolean }
```

`status` mapping and `distanceKm` (straight-line km from the user) mean the
same thing for every retailer.

## Adapter interface

`src/retailers/<name>/urls.js` (imported by popup and background; pure):

| Export | Meaning |
|--------|---------|
| `id` | `"walmart"`, `"bestbuy"`, ... |
| `label` | "Walmart", "Best Buy", ... shown in the popup |
| `host` | `"www.bestbuy.ca"`; background matches tabs on `https://<host>/*` |
| `homeUrl` | page to open when no tab exists |
| `parseProductUrl(input) -> itemId | null` | recognises this retailer's product URLs (and, for walmart only, bare ids) |

`src/retailers/<name>/content.js` (bundled as `dist/content/<name>.js`, runs on
that domain; handles the same message types as today):

| Message | Handler |
|---------|---------|
| `ping` | `{ ok: true }` |
| `lookup { itemId, postalCode }` | `getItem` + `findStores` in parallel -> `{ item, stores }` ranked by distance |
| `findInStock { itemId, postalCode, nearby, checkedIds }` | retailer-specific nationwide search -> `SearchResult`, reporting `searchProgress` |
| `selectStore` | walmart only; others answer `{ ok: false, code: "unsupported" }` |

`src/retailers/index.js` lists the adapters' `urls.js` modules and exposes
`parseProductUrl(input) -> { retailer, itemId } | null` (tries each adapter;
bare id -> walmart) and `RETAILERS` by id. Adding a retailer = one directory +
one entry here + manifest/build entries.

Shared code stays in `src/lib/`: `geo.js`, `stock-search.js`, `rank-stores.js`,
`errors.js`, `postal-code.js`. Walmart's `content/`, `parse-walmart.js`,
`parse-item-id.js` and `stores-ca.json` move under `src/retailers/walmart/`
unchanged in behaviour.

## Background

Same as today, parameterised by retailer: `getTab(adapter)` queries
`https://<host>/*`, pings, reloads a stale tab or opens `homeUrl`, waits up to
15 s. Messages carry `retailer`; unknown ids answer `{ ok: false, code:
"unsupported" }`. `selectStore` still opens `itemUrl`, restricted to the
retailer's host instead of walmart.ca only.

## Manifest and build

`host_permissions` and one `content_scripts` entry per retailer domain, each
pointing at its own bundle. `build.mjs` adds an entry point per
`src/retailers/*/content.js`. Permissions stay `storage`, `tabs`.

## Popup

- Input label becomes "Product URL (Walmart, Best Buy, Staples, Shoppers,
  GameStop) or Walmart item ID". Unrecognised input: "Paste a product URL from
  one of the supported stores."
- Item header shows `label · name`.
- Store row button: walmart "Order pickup" (unchanged); others "Open product
  page" -> `chrome.tabs.create(store.url)`.
- Nearest-in-stock box, progress line, "Keep searching farther", rate-limit
  and error messages unchanged; all adapters use the same error codes
  (`verification`, `rate_limited`, `not_found`, `api_changed`, `no_tab`,
  `unsupported`, `unknown`).
- The automatic nationwide search runs, as today, when the nearby list shows a
  known status but none is available.

## Best Buy adapter (first new retailer)

Discovery round first, same method as Walmart: open bestbuy.ca in the debug
Chrome, capture the network calls behind "Check store availability" and the
store locator, record them in `docs/bestbuy-ca-endpoints.md`, cut fixtures
into `test/fixtures/bestbuy-*.json`, verify required headers by removing them
one at a time, and measure any rate limit before choosing batch sizes.

Expected shape, to be confirmed by discovery:

- Product URL `https://www.bestbuy.ca/en-ca/product/<slug>/<sku>` (8-digit
  SKU); `parseProductUrl` accepts `/en-ca/` and `/fr-ca/`.
- An availability endpoint taking one SKU and a list of store location ids,
  returning per-store pickup status in one response.
- A store locator endpoint returning stores with coordinates for a postal
  code or lat/lon, possibly with distances.

If that holds, `findInStock` is: load the full store list (from the locator,
cached in `chrome.storage.local` for a week), ask availability for all stores
in batches sized by what the endpoint and rate limit allow, compute
`distanceKm` from the user's position (from the locator's distances via
`lib/geo.js` `locateUser`, or from the postal-code lookup if the locator
returns the origin), and return every in-stock store sorted by distance with
`complete: true`. If availability turns out to be per-store-only, fall back to
the walmart-style outward probing with `lib/stock-search.js` over the cached
store list.

## Error handling

Unchanged error type and wire shape. Each adapter maps its site's signals
(HTTP 403/429, HTML challenge pages, "not found" payloads) to the shared
codes. `searchProgress` messages are best-effort (`sendMessage(...).catch`).

## Testing

- Unit: `parseProductUrl` for all five URL patterns (and rejects others);
  background routing picks the right host per retailer (mock `chrome.tabs`);
  per-adapter parsers and request builders against real fixtures; Best Buy
  `findInStock` with a mocked `fetch` (batching, distance, sort, rate limit).
- Existing walmart tests keep passing after the move.
- Manual/e2e: debug Chrome with the unpacked extension driven by the popup
  script from this session, per retailer: one item in stock nearby, one that
  needs the far search, one unknown item.

## Out of scope

Staples, Shoppers Drug Mart and GameStop (each a later round on this
framework), keyword search, matching one product across retailers, price
comparison, pre-selecting a store on non-Walmart sites, walmart.com or other
countries.
