# Pickup Finder (walmart.ca, bestbuy.ca, staples.ca, shoppersdrugmart.ca)

Chrome extension. Paste a product URL from Walmart, Best Buy, Staples, or Shoppers
Drug Mart (Walmart item IDs still accepted) and a Canadian postal code; it lists the nearest stores
of that retailer with pickup status and then searches the whole country for the
nearest store that has the item in stock.

For Walmart, item IDs come in two forms, both accepted: numeric (`6000208927194`)
and 12-character alphanumeric (`1SZQHN3LOSE0`). Both appear at the end of the
product URL (`/en/ip/<slug>/<id>` or `/ip/<id>`).

## Build and load

```sh
npm install
npm test
npm run build      # writes dist/
```

Chrome → `chrome://extensions` → Developer mode → Load unpacked → choose `dist/`.

The extension needs a tab on the retailer's site (walmart.ca, bestbuy.ca, staples.ca
or shoppersdrugmart.ca); it opens one if none exists. If walmart.ca shows its "press and hold" bot check,
complete it in that tab and run the lookup again.

## How it works

The popup only starts a lookup; the background worker owns it as a "job"
(`src/lib/job.js`), runs lookup then the nationwide search through the retailer's
tab, and writes every step to `chrome.storage.session`. Closing the popup or
switching tabs does not stop the work: reopening the popup shows the current
state and keeps updating. The retailer's tab must stay open (in the background
is fine). If the browser shuts the worker down mid-search, the popup says the
search was interrupted and "Keep searching farther" resumes it.

Each retailer has an adapter in `src/retailers/<name>/`:

- `urls.js` recognizes product URLs for that domain.
- `content.js` runs on that domain and answers inventory lookups.

Endpoints are documented in `docs/walmart-ca-endpoints.md`, `docs/bestbuy-ca-endpoints.md`,
`docs/staples-ca-endpoints.md` and `docs/shoppers-ca-endpoints.md`.
Design: `docs/superpowers/specs/`.

For Walmart, clicking Order pickup calls the setPickup mutation, which changes the
selected pickup store for your whole walmart.ca session, not just the opened tab.
For Best Buy, Staples and Shoppers, store rows open the product page.

## Delivery

The popup asks for a fulfillment type before it searches. **Pickup** lists the
nearest stores that have the item and then searches the country for the nearest
one in stock. **Delivery** asks whether the item ships to the postal code you
typed, and for Walmart also lists the delivery locations that have it, because
walmart.ca answers pickup and delivery separately: the same item can be in stock
for pickup at one store and only for delivery at another.
The wording of the estimate is the retailer's own. Best Buy answers it in the availability
call it already makes; Staples and Shoppers each take one extra call. Walmart answers per
delivery location instead: its nodes report delivery stock for the
postal code you typed, so delivery mode shows which locations have it (see
`docs/walmart-ca-endpoints.md`). It reports no count and no delivery date, so that line
carries a status only.

Walmart marketplace items are the exception. An item sold by a third-party seller is
stocked in none of Walmart's own stores or warehouses, so every delivery node reports it
out of stock even when the seller ships it across the country. For those offers the
extension reads the product's own shipping answer instead of the nodes, shows the delivery
date Walmart quotes, names the seller, and lists no store rows, because none of them apply.

## Adding a retailer

Create `src/retailers/<name>/{urls.js,content.js}` — `walmart/urls.js` is the
smallest `urls.js` to copy from (host, homeUrl, parseProductUrl, no network),
and `bestbuy/content.js` is the smallest `content.js` (no cookies/session
handling, unlike walmart's). Then:

- register `urls.js` in `src/retailers/index.js`,
- add the host to `host_permissions` **and** a matching `content_scripts` entry
  in `src/manifest.json` (the popup and background never talk to the site
  directly; the content script is what answers `lookup`/`findInStock`/
  `selectStore`), and
- document the endpoints in `docs/<name>-endpoints.md`.

Design: `docs/superpowers/specs/`.

## When Walmart changes its API

Persisted query hashes in `src/retailers/walmart/api.js` are tied to the site
build. If lookups start failing with "Walmart changed its API", re-capture:

```sh
# 1. start a throwaway Chrome with remote debugging
"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir=%TEMP%\walmart-capture-profile https://www.walmart.ca/en
# 2. record traffic while you use the store picker and a product page
node tools/capture.js
# 3. look for nearByNodes / ItemById / setPickup in walmart-capture.jsonl,
#    update the hashes and variable lists, then refresh test/fixtures/
```

`tools/grep-capture.js` greps the capture file for pickup badges and candidate
item IDs, to help spot the right requests before updating the hashes above.

`tools/eval.js "<js expression>"` runs JavaScript inside that tab, useful for
probing variables against the live endpoint.

## End-to-end check

```sh
npm run build
node tools/e2e-popup.mjs "https://www.shoppersdrugmart.ca/x/p/BB_625273036947|M5V 3L9" "<url>|<postal>" ...
```

starts a throwaway Chrome, installs `dist/` over the DevTools protocol
(`Extensions.loadUnpacked`; Chrome 137+ ignores `--load-extension`), runs each
lookup through the real popup and prints what it shows. It must not use
`--remote-debugging-pipe`: that sets `navigator.webdriver`, and shoppersdrugmart.ca
answers such a browser with 403 on every request.

## Store lists

`tools/build-store-list.mjs` (Walmart API) and `tools/build-store-list-pages.mjs`
(Walmart store pages, not rate-limited) regenerate the store coordinate list in
`src/retailers/walmart/stores-ca.json`. `tools/build-bestbuy-stores.mjs`
regenerates `src/retailers/bestbuy/stores-ca.json`. `tools/build-staples-stores.mjs`
regenerates `src/retailers/staples/stores-ca.json`. `tools/build-shoppers-stores.mjs`
regenerates `src/retailers/shoppers/stores-ca.json` (1,059 stores; no Quebec, where the
banner is Pharmaprix on a different site).

Staples returns only the 5 nearest pickup-capable stores to a postal code (no way
to specify a store list), so the nationwide search probes outward from the catalog,
5 stores at a time, like Walmart. Staples' availability API only covers ~90 km
around the postal code, so a postal code with no Staples in that radius gets no
nationwide search yet (documented follow-up in `docs/staples-ca-endpoints.md`).

Shoppers Drug Mart's store-stock endpoint takes only coordinates (the site geocodes
postal codes with Google Maps), so the extension locates a postal code by the centroid
of its forward sortation area from `src/lib/fsa-ca.json` (GeoNames postal-code data,
CC BY 4.0, https://www.geonames.org/; regenerate with `tools/build-fsa-list.mjs`).
Distances shown for Shoppers are measured from that centroid: a couple of km off in
cities, tens of km in rural (`A0A`) areas. The endpoint returns the 10 nearest stores
within ~20 km, or only those with stock when asked, so the nationwide search probes
outward 20 km at a time, asking for in-stock stores only
(`docs/shoppers-ca-endpoints.md`). Calls need the site's public `x-apikey`; if it
rotates, update `API_KEY` in `src/retailers/shoppers/api.js` from a captured request.
If the popup says Shoppers' bot protection blocked the request, reload the
shoppersdrugmart.ca tab (open any product page there) and retry; Akamai rejects
sessions it considers automated.
