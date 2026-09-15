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

Clicking Order pickup calls Walmart's setPickup mutation, which changes the
selected pickup store for your whole walmart.ca session, not just the opened
tab.

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

`tools/grep-capture.js` greps the capture file for pickup badges and candidate
item IDs, to help spot the right requests before updating the hashes above.

`tools/eval.js "<js expression>"` runs JavaScript inside that tab, useful for
probing variables against the live endpoint.
