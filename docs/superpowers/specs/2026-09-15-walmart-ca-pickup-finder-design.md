# Walmart.ca Pickup Finder — Design

Date: 2026-09-15
Status: approved in chat, pending endpoint discovery from HAR

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
- Internal endpoints are undocumented. They are discovered from a HAR capture
  taken in the user's browser (see "Endpoint discovery"). The extension never
  ships cookies, tokens, or personal data; only URL shapes and body shapes are
  recorded.
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
   | findStores(postalCode)            -> Store[]
   | getAvailability(itemId, storeIds) -> Availability[]
   | rankStores(stores, availability)  -> Result[]
   v
popup renders Result[]
```

Popup and background never call walmart.ca directly.

## Components

| File | Responsibility | Depends on |
|------|----------------|------------|
| `manifest.json` | MV3. `host_permissions: ["*://www.walmart.ca/*"]`, permissions `storage`, `tabs`. Content script matches `https://www.walmart.ca/*`. | — |
| `popup/popup.html`, `popup/popup.js`, `popup/popup.css` | Input item ID/URL, input postal code (persisted via `chrome.storage.local`), search button, results list, error banner. | `lib/parse-item-id.js` |
| `background.js` | Message router. Locates or opens walmart.ca tab, waits for content script ready, forwards lookup, relays result/error. | — |
| `content/index.js` | Listens for `lookup` messages, orchestrates api + rank, replies. Replies `{ok:false, error}` on any throw. | `content/walmart-api.js`, `lib/rank-stores.js` |
| `content/walmart-api.js` | `findStores(postalCode)`, `getAvailability(itemId, storeIds)`. Builds requests for the discovered endpoints, parses raw JSON into the typed shapes below. Parsing functions are exported separately (`parseStores(json)`, `parseAvailability(json)`) so they are unit-testable with fixtures. | `fetch` |
| `lib/parse-item-id.js` | `parseItemId(input) -> string | null`. Accepts bare numeric ID or any walmart.ca product URL (`/en/ip/<slug>/<id>`, `/fr/ip/...`, with query string). | — |
| `lib/rank-stores.js` | `rankStores(stores, availability) -> Result[]`. Joins by store ID, sorts by distance ascending, maps status. | — |
| `docs/walmart-ca-endpoints.md` | Record of discovered endpoints: method, URL, required headers, request body shape, response fields used. Written during endpoint discovery. | HAR |

## Data shapes

```ts
type Store = {
  id: string;            // Walmart store ID
  name: string;
  address: string;       // single-line
  distanceKm: number;
  lat?: number; lon?: number;
}

type Availability = {
  storeId: string;
  status: "available" | "out_of_stock" | "unknown";
  price?: number;        // CAD
  quantity?: number;     // if endpoint exposes it
}

type Result = Store & {
  status: Availability["status"];
  price?: number;
  pickupUrl: string;     // product page URL with store selected
}
```

## Endpoint discovery (spike, blocks implementation of `walmart-api.js`)

Input: `walmart.har` captured by the user in Chrome DevTools while:
1. Opening walmart.ca, changing postal code / store in the header store picker.
2. Opening one product page, clicking the "Pick up" / "Check other stores"
   option and viewing per-store availability.

Procedure:
1. Parse HAR. Filter entries to `www.walmart.ca` with JSON responses.
2. Identify the store-search request (response contains a list with store
   names + distances) and the availability request (response keyed by store
   with stock status). Note also how the page persists the selected store
   (cookie name or URL param), needed for `pickupUrl`.
3. Record in `docs/walmart-ca-endpoints.md`: method, path, query params,
   headers that are not cookies but are required (e.g. `x-o-platform`,
   `x-o-correlation-id`, GraphQL hash), body template, and the JSON paths of
   every field mapped into `Store` / `Availability`.
4. Cut trimmed response samples into `test/fixtures/stores.json` and
   `test/fixtures/availability.json`. Strip any personal data.

If the availability endpoint requires one call per store, `getAvailability`
runs them with a concurrency limit of 3 and a 400 ms gap, and the UI caps the
store list at 10.

Set-store mechanism for `pickupUrl`: if the store is selected by a cookie
rather than a URL param, `content/index.js` sets that cookie via the same
endpoint the site uses, then `pickupUrl` is the plain product URL. Decision
recorded in the endpoints doc.

## Error handling

| Condition | Behaviour |
|-----------|-----------|
| Input yields no item ID | Popup inline error, no request. |
| Postal code fails `^[A-Za-z]\d[A-Za-z] ?\d[A-Za-z]\d$` | Popup inline error. |
| No walmart.ca tab | Background opens one, waits up to 15 s for content script ready ping, then proceeds. Timeout -> error "Open walmart.ca and try again". |
| Response is HTML or HTTP 403/412 (PerimeterX) | Error "walmart.ca asked for verification. Complete it in the walmart.ca tab, then retry." |
| Response JSON missing expected fields | Error "Walmart changed its API" plus first 200 chars of raw body. No guessing. |
| Store returns no availability entry | Status `unknown`, still listed. |

## Testing

- Unit (vitest): `parseItemId` (bare ID, en/fr URLs, query strings, junk),
  `rankStores` (sort, join, missing availability -> unknown),
  `parseStores` / `parseAvailability` against HAR fixtures.
- Manual: load unpacked in Chrome, run lookup with a known in-stock item and
  a real postal code, verify distances and pickup link open correct store.
- No automated browser tests (PerimeterX makes them unreliable).

## Out of scope

Keyword search, batch lookup, geolocation, walmart.com, price history,
notifications, Firefox.
