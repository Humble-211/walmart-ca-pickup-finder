# Pickup Finder (walmart.ca, bestbuy.ca)

Chrome extension. Paste a product URL from Walmart or Best Buy (Walmart item IDs
still accepted) and a Canadian postal code; it lists the nearest stores of that
retailer with pickup status and then searches the whole country for the nearest
store that has the item in stock.

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

The extension needs a tab on the retailer's site (walmart.ca or bestbuy.ca); it
opens one if none exists. If walmart.ca shows its "press and hold" bot check,
complete it in that tab and run the lookup again.

## How it works

Each retailer has an adapter in `src/retailers/<name>/`:

- `urls.js` recognizes product URLs for that domain.
- `content.js` runs on that domain and answers inventory lookups.

Endpoints are documented in `docs/walmart-ca-endpoints.md` and `docs/bestbuy-ca-endpoints.md`.
Design: `docs/superpowers/specs/`.

For Walmart, clicking Order pickup calls the setPickup mutation, which changes the
selected pickup store for your whole walmart.ca session, not just the opened tab.
For Best Buy, store rows open the product page.

## Adding a retailer

Create `src/retailers/<name>/{urls.js,content.js}` (see `bestbuy/` for the smallest
example), register `urls.js` in `src/retailers/index.js`, add the host to
`src/manifest.json`, and document the endpoints in `docs/<name>-endpoints.md`.
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

## Store lists

`tools/build-store-list.mjs` (Walmart API) and `tools/build-store-list-pages.mjs`
(Walmart store pages, not rate-limited) regenerate the store coordinate list in
`src/retailers/walmart/stores-ca.json`. `tools/build-bestbuy-stores.mjs`
regenerates `src/retailers/bestbuy/stores-ca.json`.
