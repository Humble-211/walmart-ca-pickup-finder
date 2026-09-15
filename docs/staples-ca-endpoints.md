# staples.ca internal endpoints (discovered 2026-09-15)

staples.ca is a **Shopify** storefront (`staples-canada.myshopify.com`) with two
Staples-owned JSON APIs bolted on. Three plain REST/JSON calls cover the whole
flow, and **every one of them was verified to return HTTP 200 from a bare
`node -e "fetch(...)"` with no cookies, no `Referer`, no `Origin`, no API key
and the default Node user agent**. There is no GraphQL, no persisted-query
hash, no tenant header and no bot clearance. In principle the extension could
call them straight from the MV3 service worker with `host_permissions:
["https://www.staples.ca/*", "https://api.staples.ca/*",
"https://api.stores.staples.ca/*"]`; in practice it should still run them from a
staples.ca content script like the walmart and bestbuy adapters do, so the
background worker stays a thin router.

**One browser-only caveat:** the availability endpoint's CORS preflight answers
`Access-Control-Allow-Origin: https://www.staples.ca` **without**
`Access-Control-Allow-Credentials`. A content-script `fetch(..., {credentials:
"include"})` therefore fails with `TypeError: Failed to fetch` after a 200
preflight. Use `credentials: "omit"` (walmart/bestbuy use `"include"` — this
retailer must not). Cookies are not needed for anything below.

No bot challenge (press-and-hold, "Access Denied", captcha) was seen at any
point across ~115 calls. Cloudflare sits in front of `www.staples.ca`
(`cf-ray`, `cf-cache-status: BYPASS` on every response) but never interstitialed.

Fixtures cut from real responses: `test/fixtures/staples-product.json`,
`test/fixtures/staples-stores.json`, `test/fixtures/staples-availability.json`.

## Headline result

**Staples does expose real per-store stock quantities** — but only for the
**5 nearest pickup stores to a postal code**, with **no way to name the stores
you want**. There is no `locations=` / `store_ids=` parameter of any kind. So
this retailer is a *walmart-style outward prober*, not a *bestbuy-style batcher*.
See "Search strategy" at the end.

## 1. Product URL shapes

| Locale | Shape | Example |
|--------|-------|---------|
| English | `https://www.staples.ca/products/<sku>-en-<slug>` | `https://www.staples.ca/products/3082604-en-brother-hl-l2405w-home-office-ready-monochrome-laser-printer` |
| English, French UI | `https://www.staples.ca/fr/products/<sku>-en-<slug>` | same handle, Shopify locale prefix; serves the **English** handle |
| French | `https://www.bureauengros.com/products/<sku>-fr-<slug>` | `https://www.bureauengros.com/products/3082604-fr-brother-hl-l2405w-imprimante-laser-monochrome-pour-bureau` |

The Shopify **handle** is the whole `<sku>-<lang>-<slug>` segment. The
**SKU/item id is the leading all-digit segment before the first hyphen**. It is
what the product page prints as "Item: 3082604" and what every Staples API keys
on.

Verified with real products:

| SKU | Digits | Handle |
|-----|--------|--------|
| `14336` | 5 | `14336-en-staples-copy-paper-20-lb-85-w-x-11-h-white-5000-sheets` |
| `3082604` | 7 | `3082604-en-brother-hl-l2405w-home-office-ready-monochrome-laser-printer` |
| `24501714` | 8 | `24501714-en-canon-pixma-tr4720-wireless-all-in-one-printer-black` |

Ids are **numeric, variable length — 5 to 8 digits observed** (do not assume a
fixed width the way bestbuy's 8-digit SKUs allow).

Two parsing notes for the adapter:

- Search-result links carry `?trk=product_clicked_trk_<shopifyVariantId>`.
  Strip the query string before taking the handle.
- **The slug is NOT decorative.** Unlike bestbuy, `…/products/3082604` and
  `…/products/3082604.js` both **404**. The full handle is required by the
  product endpoint, so keep the pasted URL's handle rather than rebuilding one
  from the SKU. (If only a SKU is known, resolve it to a handle via Algolia —
  see §6.)
- Both `www.staples.ca` and `www.bureauengros.com` are the same Shopify shop;
  `<link rel="alternate" hreflang="fr-CA">` on any product page gives the
  French twin.

## 2. Product name, price, image

```
GET https://www.staples.ca/products/<handle>.js
```

Shopify's storefront product JSON. No headers, no cookies, no query params.
Also works on `www.bureauengros.com` (French fields) and under `/fr/`.

Response (see `test/fixtures/staples-product.json`):

```
id                    6671196160129        (Shopify product id, NOT the Staples SKU)
title                 "Brother HL-L2405W Home Office-Ready Monochrome Laser Printer"  -> item.name
handle                "3082604-en-brother-…"
description           HTML-free marketing copy
vendor                "brother"
type                  "Voyageur_en_CA" | "Voyageur_Configurable_en_CA"
tags[]                ~180 "key:value" strings — see below
price                 11999                 -> item.price  (INTEGER CENTS, divide by 100)
compare_at_price      19999                 (list price; equals price when not on sale)
price_min/price_max/price_varies            (multi-variant products)
available             true                  (online purchasability, NOT store stock)
variants[]:
  id                  39723906269313        (Shopify variant id; the price-rules API keys on it)
  sku                 "3082604"             -> THE Staples SKU (authoritative)
  price               11999                 (cents)
  compare_at_price    19999
  available           true
  inventory_management "shopify" | null
featured_image        "//cdn.shopify.com/s/files/1/0036/4806/1509/products/…_square3082604_1_….jpg?v=…"   -> item.image
images[]              same, protocol-relative
url                   "/products/3082604-en-brother-…"   -> canonical path
options[], media[], selling_plan_groups[]
```

- **Prices are integer cents.** `11999` = `$119.99`.
- `featured_image` is **protocol-relative** (`//cdn.shopify.com/…`). Prefix
  `https:`. Shopify size suffixes work: insert `_200x` before the extension, or
  append `&width=200`, for a thumbnail.
- **Canonical product URL** = `https://www.staples.ca` + `url`.
- `tags[]` carries the useful flags as `"key:value"` strings. The one that
  matters here is **`bopis_eligible:True`** / **`bopis_eligible:False`** — see
  §3, because a `False` product returns an empty availability map that is
  otherwise indistinguishable from "unknown SKU". Others worth surfacing:
  `brand:Brother`, `model_num:HLL2405W`, `bc_l1_name` / `bc_l2_name` /
  `bc_l3_name` (breadcrumb category), `AverageOverallRating:number:4.1911`.

**Unknown handle:** HTTP **404** with an **empty body**. That is the "item not
found" signal. (`…/products/<bad-handle>` without `.js` returns 404 with the
full Shopify 404 HTML page — don't parse it.)

`GET …/products/<handle>.json` also exists and returns `{"product":{…}}` in the
Admin-ish shape (`body_html`, variant `price` as the string `"119.99"`). Prefer
`.js`.

### Price caveat

The number the site *displays* can be overridden for signed-in / business
accounts by
`GET https://api.staples.ca/pre/policy/execution/ext/v1.0/go_pre/pricerules/staples-canada.myshopify.com/rulesets?products=<shopify product id>`.
For an anonymous user, `.js` `price` matched the rendered price exactly on all
three products checked, so the extension can ignore the price-rules call.

## 3. Per-store pickup availability for a SKU  ← the important one

```
POST https://api.staples.ca/ecommerce/inventory/v2.0/request
Content-Type: application/json

{"locale":"en-CA","postal_code":"M5V 3L9",
 "items":[{"sku":"3082604","quantity":1000}],
 "location":"PickInStore"}
```

Exact request verified working from bare Node (no cookies, no Referer, no
Origin, no UA), and from a content script with `credentials:"omit"`.

Response (see `test/fixtures/staples-availability.json`):

```
success                 true
availability:
  "<sku>":                                  (one key per requested sku)
    "<storeNumber>":                        (STRING key — "25", "286" — this is Store.id)
        addressLine     "375 University Avenue"   -> street
        city            "Toronto"
        state           "ON"                      (province code)
        zipCode         "M5G 2J5"                 -> postal code
        phoneNumber     "4165984818"
        distance        "0.7"                     (STRING, km, from the query postal code)
        availableqty    0 | 5 | 8                 <- THE per-store stock field (INTEGER units)
        thresholdqty    50                        (constant 50 in every response seen;
                                                   the site's "50+" display cap)
        deliveryType    "ISP"                     (In-Store Pickup — only value seen)
        deliveryMessage "Ready in 2 Hours" / "Prêt en 2 h"
        yourStore       true | false              (true only for the store_number you sent)
        workingHours[]  {openTime:"900", closeTime:"2100", day:"MON"}   (24h, no colon)
```

**Per-store status is a quantity, not an enum.** There is no status string. Map:

- `availableqty > 0` -> available (show the count)
- `availableqty === 0` -> out_of_stock (the store carries it but has none)
- store number absent from the map -> unknown / not a pickup store

Note there is **no latitude/longitude** per store here — join on store number
against the store catalog (§4) if you need coordinates.

### Request fields — each one removed from a working request

| Field | Required | Behaviour when removed / changed |
|-------|----------|----------------------------------|
| `locale` | **yes** | omitted -> **400**, empty body. Must be exactly `"en-CA"` for English; **any other value, including garbage like `"xx-XX"`, falls back to French** (`deliveryMessage: "Prêt en 2 h"`). `"fr-CA"` gives French text and accented city names. |
| `postal_code` | **yes** | omitted -> **400**, empty body. This is what selects the stores. |
| `items[]` (`{sku, quantity}`) | **yes** | `quantity: 1000` is what the site sends (`DEFAULT_QUANTITY` in the theme). It does not filter the result — `quantity: 1` returns the same per-store numbers. |
| `location` | **yes** | omitted -> **400**, empty body. `"PickInStore"` selects the per-store mode. Any postal-code string here instead selects the *ship-to-home* mode (see "Other modes"). |
| `store_number` | no | purely cosmetic: it only sets `yourStore: true` on that store. Sending `store_number: "15"` with `postal_code: "M5V 3L9"` still returns the five stores near M5V — store 15 is not added. Sending `store_number` **without** `postal_code` -> 400. |
| `Content-Type: application/json` header | **yes** | omitted -> **415**, empty body. |
| `Referer` / `Origin` / `User-Agent` | no | bare Node sends none of them; 200. |
| Cookies / `x-api-key` / auth | no | none exist for this endpoint. Must use `credentials:"omit"` in a browser (see top of doc). |
| `radius`, `rad`, `num_stores`, `max_stores`, `store_count`, `limit`, `stores[]`, `store_numbers[]` | — | **all silently ignored.** Byte-identical 3138-byte response with and without them. |

### How many stores one call returns

**Always the 5 nearest pickup-capable stores to `postal_code`, and never more.**
There is no way to ask for 10, 50 or a named list. Measured against SKU
`3082604`:

| Postal code | Stores returned | Store numbers | Max distance |
|-------------|-----------------|---------------|--------------|
| `M5V 3L9` Toronto | 5 | 25, 26, 70, 86, 286 | 4.5 km |
| `M6A 2T1` North York | 5 | 3, 15, 25, 70, 86 | 5.6 km |
| `L4W 5N5` Mississauga | 5 | 2, 11, 12, 38, 257 | 5.1 km |
| `H3B 2Y3` Montréal | 5 | 22, 144, 247, 289, 306 | 3.7 km |
| `T2P 1J9` Calgary | 5 | 48, 50, 62, 110, 462 | 5.0 km |
| `K1P 5J6` Ottawa | 5 | 16, 17, 18, 107, 131 | 4.7 km |
| `V8W 1N6` Victoria | 5 | 64, 137, 168, 210, 459 | 50.4 km |
| `S7K 1J5` Saskatoon | 5 | 52, 156, 240, 270, 454 | 84.0 km |
| `K0J 1J0` Barry's Bay ON | 5 | 87, 107, 233, 318, 442 | **87.3 km** |
| `A1B 3T2` St. John's NL | 3 | 65, 101, 434 | 6.6 km |
| `S6V 1G2` Prince Albert SK | 4 | 52, 156, 240, 454 | 85.3 km |
| `Y1A 1A1` Whitehorse | 1 | 251 | 0.7 km |
| `P0T 2L0` Atikokan ON | **0** | `{}` | nearest Staples is ~200 km |

So: **cap = 5, radius ≈ 90 km** (87.3 km observed, `{}` beyond). The theme's own
store-locator constants (`MAX_SEARCH_RADIUS: 100`) corroborate a ~100 km server
ceiling.

Multiple SKUs per call work and each gets its own store map. **200 items in one
call returned 200 OK** (deduped to the 10 distinct SKUs sent), so the item batch
is effectively unlimited — but that batches *products*, not *stores*, which is
the axis this feature needs.

### Not every catalog store is a pickup store

Store **234** (85 Yonge St, Toronto) is in the store catalog (§4) but is absent
from the availability map even when queried with **its own postal code**
(`M5C 1S8` returned 3, 25, 26, 70, 286). Small-format / print-only locations are
not BOPIS-capable. ~295 of the 302 Canadian stores appear in pickup data.

### Other `location` modes (not needed, but seen)

`{"locale":"en-CA","postal_code":"M6A 2T1","items":[{"sku":"3082604","quantity":1000,"is_dropship":true}],"location":"M6A 2T1"}`
returns the **ship-to-home** view — a flat array, no store breakdown:

```
availability[]: {sku, quantity, is_dropship, available_quantity: 103,
                 min_delivery_date, max_delivery_date}
```

## 4. Store list

```
GET https://api.stores.staples.ca/api/locations?addr=M5V%203L9&rnum=10&rad=25&country=CA
GET https://api.stores.staples.ca/api/locations?lat=43.6426&lng=-79.3871&rnum=100&country=CA
```

No headers, no cookies, no API key.

Parameters (names confirmed in the theme bundle: `QUERY_KEY_ADDRESS:"addr"`,
`QUERY_KEY_LATITUDE:"lat"`, `QUERY_KEY_LONGITUDE:"lng"`, `QUERY_KEY_LIMIT:"rnum"`,
`QUERY_KEY_DISTANCE:"rad"`, `QUERY_KEY_COUNTRY:"country"`):

- `addr` — a postal code (with or without space) **or** `lat` + `lng`. One of the
  two is required.
- `rnum` — result limit. **Hard-capped at 100 records**; `rnum=1000` and
  `rnum=2000` both return 100.
- `rad` — radius in km. Also server-capped: `rad=5000` from downtown Toronto
  still stops at 23.4 km (because 100 records fill up first), and `rad=500` from
  Atikokan (`P0T 2L0`) returns `[]` rather than reaching Thunder Bay.
- `country` — `CA`.

Response (see `test/fixtures/staples-stores.json`) — a bare JSON array:

```
fid                           "CA-25"        (location id; see the prefix note below)
lid                           2010           (internal Yext-style id)
location_name                 "Staples" | "Staples Print & Marketing Services" | "Staples Wireless"
address_1                     "375 University Avenue"   -> street
address_2                     "" | null
city                          "Toronto"
region                        "ON"                       (province code)
country                       "CA"
post_code                     "M5G 2J5"
local_phone                   "416-598-4818"
lat                           "43.6534190859847"   (STRING)   -> latitude
lng                           "-79.387338459772"   (STRING)   -> longitude
distance                      "0.7"  (STRING, km from the query point)
specialties                   {"Staples":1,"Store":1} | {"Staples":1,"Print Shop":1}
isActive                      null (always)
profile.location_store_number "25"          <- JOIN KEY for §3's availability map
profile.indy_url              "https://stores.staples.ca/on/toronto/office-supplies-ca-25.html"
profile.indy_url_fr           "https://locations.bureauengros.com/on/toronto/fournitures-de-bureau-ca-25.html"
"hours:primary"               {label, name, days:{Monday:[{open:"09:00",close:"21:00"}], …}}
"hours:primary|exceptions"    duplicate of the above
```

**Important:** each physical Staples is listed up to three times, one record per
department, all sharing one address and one `location_store_number`:

| `fid` prefix | What it is |
|--------------|------------|
| `CA-<n>` | the store itself (`specialties.Store === 1`) |
| `CA-CP-<n>` | Print & Marketing counter |
| `CA-W-<n>` | Wireless counter |

Filter to `/^CA-\d+$/` (a Toronto `rnum=100` call returned 100 records = only
**33** distinct stores). **Use `profile.location_store_number`, not `fid`**, as
the id that joins to §3.

### Can one call return every Staples store in Canada?

**Not from this endpoint** — it is point-centred and hard-capped at 100 records
(~33 stores). But there is a single call that does:

```
POST https://H5YOVYKINU-dsn.algolia.net/1/indexes/store_locations/query
X-Algolia-Application-Id: H5YOVYKINU
X-Algolia-API-Key: 4689de77d9aedbf48bf24a6da6cbebdd
Content-Type: application/json

{"params":"query=&hitsPerPage=1000"}
```

(The app id and search-only key are public, straight out of
`window.ENV.algolia_API` on any staples.ca page.)

Returns **`nbHits: 302` — every Staples store in Canada in one page**:

```
store_number   251                (number)   -> Store.id, matches §3's keys
store          "Whitehorse"                   -> Store.name
province       "YK"                           (YK, SK, QC, PEI, ON, NT, NS, NL, NB, MB, BC, AB)
store_address  "303 Ogilvie Street / Whitehorse, YK Y1A 2S3"
               ^ "<street> / <city>, <prov> <postal>" — the postal code parses out of
                 all 302 with /([A-Za-z]\d[A-Za-z]\s?\d[A-Za-z]\d)\s*$/
lat, lng       60.7255919706231, -135.05937886837   (also under _geoloc)
cma_code, cma_name, objectID
```

This is the right source for a build-time `stores-ca.json` (analogous to
`tools/build-bestbuy-stores.mjs`): 302 stores, store number, name, province,
address, **postal code** and coordinates, in one request. Fall back to
`api.stores.staples.ca` at runtime for the nearby list with server-computed
`distance`.

## 5. Errors

| Case | Status | Body signature |
|------|--------|----------------|
| Unknown SKU, availability | **200** | `{"success":true,"availability":{"99999999":{}}}` |
| SKU tagged `bopis_eligible:False`, availability | **200** | identical empty map (verified with SKU `986762`) |
| No pickup store within ~90 km | **200** | identical empty map (verified with `P0T 2L0`) |
| Unknown handle, product `.js` | **404** | empty body |
| Unknown product page (no `.js`) | 404 | full Shopify 404 HTML shell — do not parse |
| Invalid postal code, availability | **400** | `{"type":"https://tools.ietf.org/html/rfc9110#section-15.5.1","title":"One or more validation errors occurred.","status":400,"errors":{"PostalCode":["The field PostalCode must match the regular expression '^\\w\\d\\w[ -]?\\d\\w\\d$'."]},"traceId":"00-…"}` |
| FSA only (`M5V`), availability | 400 | same PostalCode validation error |
| Missing `locale` / `postal_code` / `location` | 400 | **empty body**, no JSON |
| Missing `Content-Type` header | 415 | empty body |
| `credentials:"include"` from a content script | — | CORS failure: preflight 200 but no `Access-Control-Allow-Credentials`; `fetch` rejects with `TypeError: Failed to fetch`. Use `"omit"`. |
| Invalid postal code, store locator | 200 | `[]` |
| No `addr` and no `lat`/`lng`, store locator | 200 | `{"status":"FAIL","message":"Missing or invalid address, lat/lng, or IP value"}` |
| Bot challenge | — | **never observed** across ~115 calls (page loads, in-tab fetches, bare-Node fetches), with and without cookies |

**Three different conditions collapse to the same empty availability map**
(`{"success":true,"availability":{"<sku>":{}}}`): unknown SKU, BOPIS-ineligible
item, and "no store near that postal code". Disambiguate with the product `.js`
call — 404 means unknown SKU, and `tags` containing `bopis_eligible:False` means
the item has no store pickup anywhere, so the nationwide sweep can be skipped
entirely.

The availability postal-code regex is `^\w\d\w[ -]?\d\w\d$`: six characters in
letter-digit-letter / digit-letter-digit positions, with an optional space **or
hyphen** in the middle. Verified: `m5v 3l9` (lowercase) and `M5V-3L9` (hyphen)
both return the same 5 stores; a bare FSA `M5V` is rejected with 400 (unlike
bestbuy, which accepts it). `\w` also matches digits, so a syntactically valid
but nonexistent code such as `151 3L9` passes validation and comes back as
`{"success":true,"availability":{"3082604":{}}}` — another way to land on the
ambiguous empty map. Validate client-side against a real Canadian postal-code
regex rather than round-tripping.

### Rate limiting

**None found.** 40 consecutive `POST /ecommerce/inventory/v2.0/request` calls,
1 s apart, rotating over 8 postal codes, from one IP, run inside the tab:
**40/40 HTTP 200 in 77.5 s, zero 429s.** No `Retry-After`, no `x-ratelimit-*`,
no Cloudflare challenge. Markedly more permissive than walmart.ca (which 429s at
~25 calls). Still space the extension's calls ~1 s and cap them per user action.

## 6. Other endpoints seen (not needed)

- `GET https://api.staples.ca/data/fcs/v1.0/?postalCode=M5V3L9` with
  `x-api-key: c10c6b42-93bd-4e14-8dc0-76b3c607c78e` (from
  `window.ENV.FulfillmentStore`) -> `[{"id":"M5V3L9","fsa":"M5V","ldu":"3L9","fc":"99"}]`.
  Maps a postal code to its fulfilment centre. **This is the only endpoint in the
  whole flow that needs an API key**, and it is not needed for pickup.
- **Algolia product index**, for SKU -> handle when only a SKU is known:
  `POST https://H5YOVYKINU-dsn.algolia.net/1/indexes/shopify_products_title_asc/query`
  with `{"params":"query=3082604&hitsPerPage=2"}` returns both the `-en-` and
  `-fr-` hits with `handle`, `sku`, `title`, `price` (dollars, not cents), `image`.
- **`store_inventory` on that same Algolia index** — see the strategy note below.
- `GET https://api.staples.ca/ecommerce/search/v1.0/recommendation/fbt-products?sku=<sku>`
  and `…/own-brand-alternate-products?sku=<sku>` — recommendation rails.
- `https://stores.staples.ca/sitemap.xml` — 200, ~92 KB, `robots.txt` allows it;
  province/city/store directory pages. A usable but much slower alternative to
  the Algolia store index.
- `https://staples.boldapps.net/api/frontend/inventory_services` — the v1
  inventory API the theme still carries behind the `inventory_api_v2` feature
  flag. Not exercised; v2 is live.

## Search strategy

**Availability is per postal code only — it returns the 5 nearest pickup stores
within a ~90 km radius and accepts no store list. Fall back to outward probing
like walmart.**

Measured numbers:

- 5 stores per call, hard cap. Radius ~90 km (87.3 km observed).
- 302 Staples stores in Canada; ~295 are pickup-capable.
- A **greedy set cover** over the 302-store catalog, seeding each call with a
  store's own postal code (which guarantees that store is in its own result set)
  and crediting the 5 nearest stores within 90 km, needs **116 calls** to touch
  every store in Canada. (The naive `ceil(302 / 5) = 61` is unreachable because
  isolated stores — Whitehorse, Prince Albert, St. John's — burn a whole call for
  1-4 stores.) At the ~1 s spacing the API tolerates, a true exhaustive sweep is
  a ~2-minute operation.

So Task 8 should reuse walmart's outward-probing `lib/stock-search.js` shape, not
bestbuy's batched pass:

1. Build `stores-ca.json` offline from the Algolia `store_locations` index (§4):
   302 rows of `{store_number, name, province, street, city, postal, lat, lng}`.
2. Call product `.js` once. If 404 -> "Item not found". If `tags` contains
   `bopis_eligible:False` -> "Not available for pickup anywhere", stop.
3. Nearby list: one availability call with the user's postal code gives the 5
   nearest stores with live `availableqty` **and** server-computed `distance`.
   If any has `availableqty > 0`, the nearest-in-stock answer is already in hand
   — zero extra calls.
4. Otherwise probe outward: sort the 302 catalog stores by haversine from the
   user, walk the list, and for each store not yet covered by a previous
   response issue one availability call **seeded with that store's own postal
   code** (parsed from `store_address`). Mark all 5 returned stores as covered.
   Stop at the first `availableqty > 0`. Space calls ~1 s; report progress the
   way the bestbuy adapter does ("N checked, M to go").
5. Cap the sweep (e.g. 40 calls ≈ 200 stores ≈ 40 s) and offer a "keep
   searching" affordance rather than always running all 116.

### Worthwhile optimisation

The Algolia product index carries a **`store_inventory` array with a quantity for
every store, for every product, in one call**:

```
POST https://H5YOVYKINU-dsn.algolia.net/1/indexes/shopify_products_title_asc/query
{"params":"query=3082604&hitsPerPage=1&attributesToRetrieve=handle,sku,store_inventory,updated_at"}

-> store_inventory: [{"store_2":3},{"store_3":6},…]   295 entries
```

**It is stale and must not be shown to the user as stock.** The record fetched
on 2026-09-15 carried `updated_at: 2026-09-11` — four days old — and every
overlapping store over-reported against the live API (index 25=2 / 26=2 / 70=10 /
86=4 / 286=6 vs live 0 / 0 / 5 / 1 / 4).

But as a **candidate filter** it collapses the sweep from 116 calls to a handful:
take the stale index, sort its non-zero stores by distance from the user, and
confirm the top few with real availability calls seeded on those stores' postal
codes. Typical cost: 1 Algolia call + 1-3 availability calls instead of dozens.
Note it adds `https://*.algolia.net/*` to `host_permissions` and depends on an
index Staples could stop publishing, so keep step 4's plain outward probe as the
fallback path.
