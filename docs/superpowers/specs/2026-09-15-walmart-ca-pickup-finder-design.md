# Walmart.ca Pickup Finder — Design

Date: 2026-09-15
Status: approved in chat; endpoints discovered and verified 2026-09-15 (see docs/walmart-ca-endpoints.md)

## Goal

Chrome extension. User enters one walmart.ca product (item ID or product URL)
and a Canadian postal code. Extension returns nearby Walmart stores sorted by
distance, each with pickup status (available / out of stock / unknown) and
price when known, plus a button that opens the product page with that store
selected so the user can order pickup.

## Constraints

- walmart.ca has no public API and blocks non-browser traffic with PerimeterX
  ("press and hold" challenge). All requests must originate from a content
  script running inside a walmart.ca tab so they carry the user's cookies,
  origin and sensor headers.
- Internal endpoints are undocumented. They were discovered with a Chrome
  DevTools Protocol capture (`tools/capture.js`, `tools/eval.js`) and are
  recorded in `docs/walmart-ca-endpoints.md`. The extension never ships
  cookies, tokens, or personal data.
- One product per lookup. No batch, no keyword search (YAGNI).

## Architecture

```
popup (UI)
   | chrome.runtime.sendMessage({type:"lookup", itemId, postalCode})
   v
background service worker
   | find existing https://www.walmart.ca/* tab, else chrome.tabs.create
   | chrome.tabs.sendMessage(tabId, {type:"lookup", ...})
   v
content script (walmart.ca tab)
   | getItem(itemId)                        -> Item   (ItemById)
   | findStores(postalCode, itemId, max=10) -> Store[] with status (nearByNodes, one call)
   | rankStores(stores)                     -> Result[]
   v
popup renders Result[]
```

Popup and background never call walmart.ca directly.

## Components

| File | Responsibility | Depends on |
|------|----------------|------------|
| `manifest.json` | MV3. `host_permissions: ["*://www.walmart.ca/*"]`, permissions `storage`, `tabs`. Content script matches `https://www.walmart.ca/*`. | — |
| `popup/popup.html`, `popup/popup.js`, `popup/popup.css` | Input item ID/URL, input postal code (persisted via `chrome.storage.local`), search button, results list, error banner. | `retailers/walmart/urls.js` |
| `background.js` | Message router. Locates or opens walmart.ca tab, waits for content script ready, forwards lookup, relays result/error. | — |
| `retailers/walmart/content.js` | Listens for `lookup` and `selectStore` messages, orchestrates api + rank, replies. Replies `{ok:false, error}` on any throw. | `retailers/walmart/api.js`, `lib/rank-stores.js` |
| `retailers/walmart/api.js` | `getItem(itemId)`, `findStores(postalCode, itemId, maxCount)`, `selectStore(store, postalCode)`. Builds requests for the discovered endpoints (headers, hashes, variable templates) and hands raw JSON to the parsers. | `fetch`, `retailers/walmart/parse.js` |
| `retailers/walmart/urls.js` | `parseItemId(input) -> string | null`. Accepts bare numeric ID or any walmart.ca product URL (`/en/ip/<slug>/<id>`, `/fr/ip/...`, with query string). | — |
| `retailers/walmart/parse.js` | Pure parsers: raw `nearByNodes` JSON -> `Store[]` (status mapped), raw `ItemById` JSON -> `Item`. Throws `WalmartApiError` with a short reason when expected fields are missing or `errors[]` is present. | — |
| `lib/rank-stores.js` | `rankStores(stores) -> Store[]`. Sorts by distance ascending only. | — |
| `docs/walmart-ca-endpoints.md` | Record of discovered endpoints: method, URL, required headers, request body shape, response fields used. | `tools/capture.js` |
| `tools/capture.js`, `tools/eval.js` | Dev-only. CDP network capture and in-tab JS eval against a Chrome started with `--remote-debugging-port=9222`. Used to re-discover endpoints when hashes change. Not shipped in the extension. | Node 24 |

## Data shapes

```ts
type Item = {
  id: string;            // "6000208927194"
  name: string;
  priceString: string;   // "$21.98" (CAD); "" if missing
  imageUrl: string | null;
  url: string;           // "https://www.walmart.ca" + canonicalUrl
  pickupEligible: boolean; // pickupOption.availabilityStatus != null
}

type Store = {
  id: string;            // "3635"
  name: string;          // displayName
  address: string;       // "300 Borough Dr, Scarborough, ON M1P 4P5"
  postalCode: string;
  distanceKm: number;    // parseFloat(distance)
  status: "available" | "out_of_stock" | "unknown";
  accessPointId: string | null; // first active PICKUP_INSTORE, else PICKUP_CURBSIDE
}
```

Price is per item, not per store (the availability call does not return price).

## Lookup flow

1. Popup validates input, sends `{type:"lookup", itemId, postalCode}`.
2. Content script calls `getItem(itemId)` and `findStores(postalCode, itemId, 10)`
   in parallel (`Promise.all`). Two requests total.
3. `rankStores` sorts by distance. Popup shows item header (name, price, image,
   "not pickup-eligible" banner when `pickupEligible` is false) and the store list.
4. "Order pickup" button on a store sends `{type:"selectStore", store, postalCode, itemUrl}`.
   Content script calls `selectStore` (setPickup mutation with the store's
   `accessPointId`), then background opens `itemUrl` in a new tab. The page
   loads with that store selected.

5. Nearest in stock (added 2026-09-15). `nearByNodes` only ever returns the
   50 stores nearest a point (100 km max radius), so for a scarce item every
   nearby store can be out of stock while a store 300 km away has it. After
   step 3 the popup sends `{type:"findInStock", itemId, nearby, checkedIds}`.
   The content script estimates the user's position from the nearby stores'
   reported distances (`lib/geo.js` `locateUser`, least squares against
   `lib/stores-ca.json`, a generated list of Canadian Walmart stores with
   coordinates), then `lib/stock-search.js` probes outward: each probe is a
   `nearByNodes` call by lat/lon (radius 100 km, the maximum; 50 stores). The
   probe centre is chosen among the nearest unchecked stores and the centroids
   of the unchecked stores around them, preferring one whose simulated response
   includes the nearest unchecked store (nearest-first) and holds the most
   unchecked stores. It stops when the nearest in-stock store is provably found,
   the catalog is exhausted, or the budget (10 calls, 1 s apart; walmart
   rate-limits at ~25 calls per several minutes, with growing penalties) is
   spent. Because one call reaches at most 100 km, covering all of Canada takes
   ~57 calls, i.e. several "Keep searching farther" rounds with waits in between;
   one round covers roughly the nearest 30-140 stores depending on density.
   Progress is streamed to the popup as `searchProgress` messages. The popup
   shows the closest in-stock stores in a "Nearest in stock" box with a "Keep
   searching farther" button that continues from `checkedIds`.
   `tools/build-store-list.mjs` (API) and `tools/build-store-list-pages.mjs`
   (store pages, not rate-limited) regenerate the store list.

Endpoint details, headers, hashes and variable templates: `docs/walmart-ca-endpoints.md`.

## Error handling

| Condition | Behaviour |
|-----------|-----------|
| Input yields no item ID | Popup inline error, no request. |
| Postal code fails `^[A-Za-z]\d[A-Za-z] ?\d[A-Za-z]\d$` | Popup inline error. |
| No walmart.ca tab | Background opens one, waits up to 15 s for content script ready ping, then proceeds. Timeout -> error "Open walmart.ca and try again". |
| Response is HTML or HTTP 403/412 (PerimeterX) | Error "walmart.ca asked for verification. Complete it in the walmart.ca tab, then retry." |
| `errors[0].message == "INVALID_POSTAL_CODE"` | Error "Postal code not recognized by Walmart". |
| `data.product` null (unknown item ID) | Error "Item not found". |
| HTTP 400 or JSON missing expected fields | Error "Walmart changed its API" plus first 200 chars of raw body. No guessing. |
| Store has no `product.availabilityStatus` | Status `unknown`, still listed. |
| Store has no usable `accessPointId` | Listed, "Order pickup" button disabled. |
| `setPickup` fails | Error shown in popup; item tab still opened so user can pick store manually. |

## Testing

- Unit (vitest): `parseItemId` (bare ID, en/fr URLs, query strings, junk),
  `parseStores` / `parseItem` against `test/fixtures/*.json` (status mapping,
  address join, accessPointId choice, error cases), `rankStores` (sort),
  request builders in `walmart-api.js` (URL, headers, variables) with a mocked `fetch`.
- Manual: load unpacked in Chrome, run lookup with a known in-stock item and
  a real postal code, verify distances and pickup link open correct store.
- No automated browser tests (PerimeterX makes them unreliable).

## Out of scope

Keyword search, batch lookup, geolocation, walmart.com, price history,
notifications, Firefox.
