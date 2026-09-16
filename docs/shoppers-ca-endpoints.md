# shoppersdrugmart.ca internal endpoints (discovered 2026-09-15)

shoppersdrugmart.ca is a Loblaw Digital **Next.js** site backed by a JSON API on
`https://api.shoppersdrugmart.ca/beauty/v2/shoppersdrugmart/…` (Apigee; the
"beauty" prefix is historical, health products use it too). Two calls cover the
whole flow. Unlike bestbuy/staples, **nothing works from outside a browser**:
`www.shoppersdrugmart.ca` and `api.shoppersdrugmart.ca` both sit behind Akamai
Bot Manager and answer a bare `node -e "fetch(...)"` / curl with **403 "Access
Denied"** HTML, whatever headers are sent. From a content script on
`www.shoppersdrugmart.ca` every call below returns 200, provided:

- the request carries the site cookies — **`credentials: "include"`** (the
  opposite of staples: with `"omit"` Akamai rejects the request and the browser
  reports `TypeError: Failed to fetch`);
- the header **`x-apikey: r3kEMAxRsQQtyjXiIJOTFNN75vcsJFxH`** is present. It is
  the site's public key, embedded in its JS bundle and sent on every API call.
  Without it: **401** `{"error":"invalid_client",…}`. If the site rotates it,
  every lookup fails with "Shoppers Drug Mart changed its API" — update
  `API_KEY` in `src/retailers/shoppers/api.js` from a captured request;
- **the browser is not flagged as automated**: with `navigator.webdriver`
  true (Chrome started with `--remote-debugging-pipe`, as automation tools
  do) Akamai answers every request — the HTML pages too — with **403 "Access
  Denied"**. The API 403 carries no CORS headers, so a content script sees it
  as `TypeError: Failed to fetch`. A normal Chrome, even one started with
  `--remote-debugging-port` for capture, is not affected: a fresh profile
  gets 200 on its very first call with no interaction needed (`_abck` stays
  in its `~-1~` form and that is fine). One more case: a tab the extension has
  just opened **in the background** gets the same 403 for its first ~12 s
  (measured: 403 until 11 s, 200 from 13 s on; a foreground tab answers 200 at
  1 s), presumably because the site's bot-protection script boots slowly in a
  hidden tab. The adapter therefore retries a TypeError 5 times 3 s apart
  before mapping it (or a visible 403) to the `verification` code with a
  "reload the tab and retry" message.
  Also, a freshly opened home page **reloads itself once ~15 s after load**
  (`Page.frameRequestedNavigation reason=reload`), which kills a content
  script mid-answer; `background.js` re-sends `lookup`/`findInStock` to the
  re-pinged tab up to three times for that reason.

`language: en` is what the site sends; omitting it made no difference. The
site's tracing headers (`x-b3-*`, `traceparent`, `requestId`, `snowplow-userid`)
are not needed. No captcha / press-and-hold was seen across ~120 calls; a burst
of 30 store-stock calls 250 ms apart all returned 200 (no rate limit found).

Fixtures cut from real responses: `test/fixtures/shoppers-variant.json`,
`test/fixtures/shoppers-base.json`, `test/fixtures/shoppers-store-details.json`.

## Headline result

**Per-store stock is real (integer quantities), returned for the 10 nearest
stores within ~20 km of a latitude/longitude, with an `inStock` filter that
returns the 10 nearest stores that HAVE stock.** There is no store-list
parameter and, crucially, **no postal-code parameter: the site geocodes the
postal code with Google Maps in the browser** and only ever sends coordinates.
The extension therefore locates a postal code offline by the centroid of its
forward sortation area (§0), and the nationwide search is the outward prober
with a 10-store / 20 km probe shape that asks for in-stock stores only (§5).

## 0. Postal code → coordinates

`src/lib/fsa-ca.json` (built by `tools/build-fsa-list.mjs`) maps each of the
1,651 Canadian FSAs (first three characters of a postal code) to a centroid
from the GeoNames postal-code dump (`https://download.geonames.org/export/zip/CA.zip`,
CC BY 4.0, credit: https://www.geonames.org/). Measured against the 1,188
catalog stores' real coordinates:

| FSA kind | stores | median error | 90th pct | max |
|----------|--------|--------------|----------|-----|
| urban (`A1A`) | 1,124 | 1.6 km | 6.1 km | 174 km |
| rural (`A0A`) | 64 | 41 km | 101 km | 351 km |

Google's geocode of `M5V 3L9` is 1.0 km from the `M5V` centroid. So in cities
the "nearest 10" and the distances shown are a couple of km off at worst; in
rural FSAs the nearby list can miss the truly nearest store, but the
nationwide search still probes every catalog store, so the *in-stock* result is
still found — only its distance is approximate. Distances the popup shows for
Shoppers are therefore "from the centre of your FSA", not from your door.

An FSA absent from the table (e.g. a made-up postal code) maps to the
`invalid_postal` error.

## 1. Product URL shape

```
https://www.shoppersdrugmart.ca/<slug>/p/BB_<baseCode>?variantCode=<variantCode>
```

Examples: `…/webber-magnesium-bisglycinate-200-mg/p/BB_625273036947?variantCode=625273036947`
(single variant, base = variant), `…/bioderma-sensibio-h2o/p/BB_3701129812075?variantCode=3701129812105`
(sized product: the 500 mL variant of base 3701129812075). Codes are UPC-like
digit strings (12-13 digits seen); the parser accepts any `[A-Za-z0-9]+`. The
slug is decorative. The French UI uses the same URLs with `?lang=fr` (there is
no `/fr/` prefix); Quebec shoppers are redirected to `pharmaprix.ca`, a
different host and banner that this adapter does not cover.

**Item id = `variantCode` when present, else the base code.** Every endpoint
keys on the variant code, and the base code is itself a valid variant code
for every product tried (`variantProduct/3701129812075/details` → 200, the
default 250 mL size). Should a base-only code ever 404, `api.getItem` falls
back to `baseProduct/BB_<code>/details` → `variantsSummary.variantOptions[0].code`.

## 2. Product name, price, image

```
GET https://api.shoppersdrugmart.ca/beauty/v2/shoppersdrugmart/product/variantProduct/<variantCode>/details
```

(`?province=BC` is what the site appends; without it the response is the same.)

Response (see `test/fixtures/shoppers-variant.json`):

```
code              "SDM_625273036947"            (variant code with the SDM_ prefix)
name              "Magnesium Bisglycinate 200 mg"   -> item.name (prefixed with brandName)
brandName         "Webber"
price             {value: 24.99, formattedValue: "$24.99"}      regular price
specialPrice      {value: 14.99, formattedValue: "$14.99"}      only while on sale
effectivePrice    {value: 14.99, formattedValue: "$14.99"}      what the page shows -> item.priceString
images[]          {format: "size100" | "size200" | …, url: "https://digital.loblaws.ca/SDM/SDM_<code>/en/1/<code>_en_01_v3_<px>.jpeg"}
url               "/webber-…/p/BB_625273036947?variantCode=625273036947"
canonicalUrl      "https://www.shoppersdrugmart.ca/webber-…/p/BB_625273036947?variantCode=625273036947"  -> item.url
bopisIneligible   false          -> item.pickupEligible = !bopisIneligible
isOutOfStock      false          (online stock, not store stock)
stock.stockLevel  56             (online warehouse quantity)
purchasable, badges[], description (HTML), ingredients, howToApply, jsonLd {…}
```

**Unknown code:** HTTP **404** `{"errors":[{"reason":"productNotFound",…}]}` →
`not_found`. (Base-product companion: `GET …/product/baseProduct/BB_<baseCode>/details`
→ `breadCrumbs[]`, `promotions[]`, `variantsSummary.variantOptions[] {code,
size, unit, isOutOfStock}`; 404 the same way. Fixture `shoppers-base.json`.)

## 3. Per-store stock for a product  ← the important one

```
POST https://api.shoppersdrugmart.ca/beauty/v2/shoppersdrugmart/store-locator/store-details?lang=en
Content-Type: application/json
x-apikey: r3kEMAxRsQQtyjXiIJOTFNN75vcsJFxH

{"latitude":43.6416,"longitude":-79.3870,"productId":"625273036947","inStock":false,"storeType":1}
```

This is what the product page's "Find in store" panel sends after geocoding the
typed postal code. Response (see `test/fixtures/shoppers-store-details.json`):

```
id                   "SDM_625273036947"
count                10
storeInventory[]:
  quantity           3 | 0                       <- THE per-store stock (integer units)
  bopisIneligible    false | true                (store cannot do online pickup orders; stock is still real)
  store:
    storeId          "1321"                      (STRING, 4 digits, zero-padded — Store.id)
    distance         0.46                        (NUMBER, km from the request point)
    latitude         43.6383
    longitude        -79.3904
    storeAddress     {id, name: "Shoppers Drug Mart Queen's Quay", line1, town, postalCode, province, phone}
    storeTimes[]     {openHour: "08:00", closeHour: "24:00", dayOfWeek: "Monday"}
```

Status mapping: `quantity > 0` → available, `quantity === 0` → out_of_stock.
The site itself labels `bopisIneligible` stores exactly like the others in
"Find in store" (only online pickup ordering is unavailable there), so the
extension does too.

**HTTP 204 with an empty body = no store within range** (Atikokan ON,
Montréal — see below). The client treats it as `[]`.

### Request fields — each one removed from / varied on a working request

| Field | Required | Behaviour |
|-------|----------|-----------|
| `latitude`, `longitude` | **yes** | the only way to say where. No `postalCode`/`address` field exists. |
| `productId` | **yes** | omitted → **400** `"Product Id cannot be blank"`. Variant code; `SDM_`-prefixed works too. **An unknown product returns the same 10 stores with `quantity: 0`** (200), so unknown-vs-out-of-stock must be told apart by §2. |
| `inStock` | no (site sends `false`) | `true` → only stores with `quantity > 0`, still the nearest 10, still ~20 km. Unknown product + `inStock:true` → 200 with an empty `storeInventory`. |
| `storeType` | no | `1` is what the site sends; omitted → same result; `0` → **422**; `2` → **204**. Keep `1`. |
| `count`, `pageSize`, `size`, `limit`, `maxResults`, `radius`, `maxDistance`, `distance`, `storeIds[]`, `stores[]` | — | **all silently ignored** (byte-identical response). |
| `?lang=fr` | no | French strings only; same stores. |
| `x-apikey` header | **yes** | omitted → 401. |
| cookies | **yes** | `credentials:"omit"` → request blocked (Akamai). |

### How many stores one call returns, and how far it looks

**Always the 10 nearest stores to the point, never more, within a fixed
radius of roughly 20 km.** Measured by moving north from Whitehorse (two stores
at 60.72 N):

| Distance from the stores | Result |
|--------------------------|--------|
| 0 km | 2 stores (0.5 km) |
| 10 km | 2 stores (9.5 / 10.2 km) |
| 20 km | 1 store (19.5 km) |
| 25, 30, 35, 40, 45, 50, 100, 150, 200, 300, 500 km | **204** |

Other points: downtown Toronto → 10 stores within 1.1 km; Thunder Bay → 9
stores within 10.9 km (the catalog's 10th-nearest is 304 km away); Halifax with
`inStock:true` → 10 in-stock stores within a few km; Atikokan ON → 204;
**Montréal (45.50, -73.57) → 204** — Quebec stores are Pharmaprix and are not
served by this API/banner.

The adapter models the probe as `{ maxCount: 10, radiusKm: 20 }`. 20 is the
largest distance seen to return a store; if the true cutoff is a bit larger the
prober just covers slightly less per call than it could.

## 3b. Ship-to-home (delivery) for a postal code

```
GET https://api.shoppersdrugmart.ca/beauty/v2/shoppersdrugmart/product/<variantCode>/fulfillment-options?storeId=&postalCode=M5V3L9
```

Same api key and cookies as everything else here. The postal code goes **without its
space**, as the site sends it. Response (fixture `test/fixtures/shoppers-delivery.json`):

```
fulfillment.shipping.status                 "AVAILABLE" | "POSTAL_CODE_NOT_SET"
fulfillment.shipping.quantity               56          (units available to ship)
fulfillment.shipping.estimatedDeliveryTime  "Estimated delivery in 1-3 business days"
fulfillment.pickup.{status,quantity,estimatedPickupTime}   only with a storeId
fulfillment.store.{status,quantity,address}                only with a storeId
```

The estimate really does follow the postal code (same product: "1-3 business days" for
M5V 3L9, "10-16 business days" for Y1A 1A1), so it is worth the extra call. Without a
`postalCode` the shipping block is `{"status":"POSTAL_CODE_NOT_SET"}`, which
`parseDelivery` maps to unknown. `storeId=` stays empty: the pickup numbers come from
§3, which covers ten stores at once instead of one.



The API itself has no store-list endpoint (`…/store-locator/stores`,
`…/stores/<id>`, `/api/v1/stores/<id>` all 404). The store list comes from the
site's chat widget (Salesfloor), which is public and works from bare Node:

```
GET https://api.services.shoppersdrugmart.ca/stores?filter[locale]=en_US&per_page=5000
```

Returns an object keyed `"0"…"1188"` plus a pagination row (`from`, `to`,
`count`, `total`, `pages`). Each store:

```
retailer_store_id   "1321"  (matches storeInventory[].store.storeId — the join key;
                             1-3 digit ids appear unpadded here, e.g. "985" for "0985")
name                "Queen's Quay  - Store 1321"  |  "BOTWOOD (closed)"
latitude/longitude  "43.6383" / "-79.3904"   (STRINGS)
address, city, region, postal ("M5V 3A6"), phone, timezone
shame_type          "store"      is_virtual "0"
```

`tools/build-shoppers-stores.mjs` keeps the open, non-virtual `store` rows
with coordinates (1,059 of 1,190 on 2026-09-15: 126 are marked `(closed)`, one
is a test store), pads ids to 4 digits, and writes
`src/retailers/shoppers/stores-ca.json` as
`{ id, name: "Shoppers Drug Mart <short name>", address, postalCode, lat, lon }`.
No Quebec stores are listed (Pharmaprix). Two stores carry mistyped postal codes
in the source (`NBW 3T5`, `K7V OB4`) and are kept as-is.

## 5. Search strategy

- **Lookup:** `variantProduct` details, then `store-details` (`inStock:false`)
  at the FSA centroid (the product call resolves the code and catches unknown
  products first). Nearby list = the 10 stores with their status.
- **Nationwide search:** `lib/stock-search.js` outward prober with
  `{ maxCount: 10, radiusKm: 20, centroids: true }`; each probe calls
  `store-details` with **`inStock: true`** and reports
  `coveredKm = fewer than 10 hits ? 20 : distance of the farthest hit`, so
  every catalog store inside that circle counts as checked even though the
  response only names the in-stock ones. Where the item is common the first
  probe settles the search; where it is rare each empty probe clears a 20 km
  circle. Max 40 calls per click, 1 s apart; "Keep searching farther" resumes
  from `checkedIds`.
- No `selectStore`: store rows open the product page.

## 6. Other calls seen (not used)

- `GET …/product/<variantCode>/fulfillment-options` **with** a `storeId` adds
  `fulfillment.pickup` / `fulfillment.store` for that one store. The extension calls
  it without a store id, for delivery only (§3b); per-store pickup comes from §3.
- `POST https://prod-sdm-bff.api.loblaw.digital/beauty/v2/sdui/views/sdm-pdp-hybrid-page`
  (`x-loblaw-tenant-id: SHOPPERS_DRUG_MART`, same api key) — server-driven UI
  layout for the page, no stock.
- `GET https://api.pcexpress.ca/pcx-bff/api/v1/pickup-locations?bannerIds=shoppersdrugmart`
  (Loblaw's grocery API, `x-apikey: C1xujSegT5j3ap3yexJjqhOfELwGKYvz`) → `[]`;
  Shoppers is not on that platform.
