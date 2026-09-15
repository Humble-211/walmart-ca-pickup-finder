# bestbuy.ca internal endpoints (discovered 2026-09-15)

Three plain REST/JSON endpoints under `https://www.bestbuy.ca` cover the whole
flow. Unlike walmart.ca there is **no GraphQL, no persisted-query hash, no tenant
header, no cookie and no bot clearance**: every call below was verified to return
HTTP 200 from a bare `node -e "fetch(url)"` with no cookies, no `Referer`, no
`Origin` and the default Node user agent. The extension can therefore call them
straight from the MV3 service worker with `host_permissions:
["https://www.bestbuy.ca/*"]` — no content script and no `credentials:"include"`
needed.

No bot challenge (press-and-hold / "Access Denied") was seen at any point during
discovery.

Fixtures cut from real responses: `test/fixtures/bestbuy-product.json`,
`test/fixtures/bestbuy-stores.json`, `test/fixtures/bestbuy-availability.json`.

Product URL shape: `https://www.bestbuy.ca/en-ca/product/<seo-slug>/<sku>`.
The SKU is the trailing all-digit path segment (8 digits today, e.g. `19446111`);
the slug is decorative and not needed by any endpoint. Note the PS5 Pro URL in
the task brief (`/playstation-5-pro-console/18291446`) now 404s — the product was
delisted. Working SKUs used below: `19446111` (PlayStation 5 Slim 1TB Console),
`19491570` (DualSense controller, Midnight Black).

## Common headers

There are none. The two things that look like headers — `accept` and
`accept-language` — are **query-string parameters** on the availability endpoint,
not HTTP headers. Verified by removing each parameter one at a time from a
working availability request:

| Parameter | Value | Required |
|-----------|-------|----------|
| `accept` (query) | `application/vnd.bestbuy.standardproduct.v1+json` | **yes** for per-store data. Omit it (or send `...simpleproduct.v1+json`) and the response drops `pickup.locations` entirely and returns only the aggregate `pickup.status` |
| `accept-language` (query) | `en-CA` | no — response identical without it (store names come back in English either way) |
| `postalCode` (query) | `M5V 3L9` | no for the availability call (per-store results are keyed by `locations`, not by the postal code); **must** match the postal-code regex if sent (see Errors) |
| `locations` (query) | pipe-separated store ids | no, but without it `pickup.locations` is `[]` and `pickup.status` is `"NotAvailable"` |
| `skus` (query) | pipe-separated SKUs | yes |
| Cookies | — | **no** (`credentials:"omit"` returns identical JSON) |
| `Referer` / `Origin` / `User-Agent` | — | no |

Send `accept`, `accept-language`, `locations` and `skus`; skip `postalCode`
unless you have already validated it.

## 1. Per-store pickup availability for a SKU

```
GET /ecomm-api/availability/products
    ?accept=application%2Fvnd.bestbuy.standardproduct.v1%2Bjson
    &accept-language=en-CA
    &locations=927%7C196%7C163%7C932%7C617        (pipe-separated locationIds)
    &postalCode=M5V%203L9                          (optional)
    &skus=19446111                                 (pipe-separated SKUs)
```

Exact request verified working (no headers, no cookies):

```
https://www.bestbuy.ca/ecomm-api/availability/products?accept=application%2Fvnd.bestbuy.standardproduct.v1%2Bjson&accept-language=en-CA&locations=927%7C196%7C163%7C932%7C617%7C195%7C179%7C200&postalCode=M5V%203L9&skus=19446111
```

Response (see `test/fixtures/bestbuy-availability.json`):

```
availabilities[]:
  sku                     "19446111"
  sellerId                "bbyca"  (a marketplace seller id here = third-party item)
  saleChannelExclusivity  "InStoreAndOnline" | "OnlineOnly"
  isGiftCard, isService   booleans
  pickup.status           aggregate across the requested locations
  pickup.purchasable      boolean
  pickup.locations[]:
      locationKey         "927"                      -> Store.id (matches locationId in §3)
      name                "Downsview"                -> Store.name
      hasInventory        true | false               <- THE per-store status field
      quantityOnHand      22 | 0                     (integer units on hand)
      isReservable        true | false               (can be reserved for pickup)
      reservable          duplicate of isReservable
      supportsFulfillment true | false               (false = store cannot fulfil this item at all)
      fulfillmentKey      "506"
      id, price, fulfillmentPartnerId   always null in every response seen
  shipping.status         "InStock" | "InStockOnlineOnly" | ...
  shipping.quantityRemaining, shipping.levelsOfServices[] (carrier/price/deliveryDate)
```

**Per-store status is boolean, not an enum.** There is no per-store status string.
Map it as:

- `hasInventory === true` -> available (`quantityOnHand` gives the count)
- `hasInventory === false && supportsFulfillment === true` -> out_of_stock
- store id absent from `pickup.locations` -> unknown (see below)

`pickup.status` (the aggregate over the locations you asked about) takes the
values `"InStock"`, `"OutOfStock"`, `"OnlineOnly"`, `"NotAvailable"`. It is a
useful early-out: `"OnlineOnly"` / `"NotAvailable"` means no store will ever have
it, so the nationwide search can stop immediately.

### How many locations one call accepts

Measured by bisection against SKU `19446111`:

| locations sent | result |
|----------------|--------|
| 10, 50, 51, 55, 60, 75, 80, 85, 86, 90, 95, 96 | HTTP 200 |
| 97 | HTTP 400, upstream body `{"timestamp":...,"path":"/api/v1/products","status":400,"error":"Bad Request","requestId":"..."}` |
| 98, 100, 161 | HTTP 400, gateway body `{"errorCode":"1103","errorMessage":"Invalid query parameter: getProductAvailability.locations: must match \"^$\|^\\d+(?:\\\|\\d+){0,96}$\""}` |

The gateway regex allows at most 97 ids (`1 + {0,96}`), but the upstream service
rejected 97 in testing. **Use 96 as the ceiling; 50 is what the site itself
sends.**

The response can contain *fewer* locations than requested — ids that the
fulfilment service does not carry for that item are silently dropped (e.g. 95 ids
in -> 85 locations back; the site's own 50-id call came back with 41). Never
assume positional correspondence: match on `locationKey`, and treat a missing id
as unknown rather than out-of-stock.

Multiple SKUs in one call work and each gets its own `pickup.locations`:
`&skus=19446111%7C19491570%7C99999999` returned three `availabilities` entries.

## 2. Product name, price, image

```
GET /api/v1/catalog/query?ids=19446111&lang=en-CA
```

`ids` is comma-separated and accepts several SKUs at once (the site batches ~24).
`&include=reviews` is what the site adds; it is optional.

Response (see `test/fixtures/bestbuy-product.json`):

```
total                  1                 (0 = SKU does not exist)
items[]:
  sku                  "19446111"
  name                 "PlayStation 5 Slim 1TB Console"          -> item.name
  salePrice            819.99  (number, CAD)                      -> item.price  (current price)
  regularPrice         819.99  (number, CAD)                      (list price; > salePrice when on sale)
  saleEndDate          null | ISO date
  thumbnailImage       "https://multimedia.bbycastatic.ca/multimedia/products/150x150/194/19446/19446111.jpg"  -> item.image
  highResImage         ".../1500x1500/..."   ("…/noimage1500x1500.jpg" when there is no photo)
  productUrl           "/en-CA/product/playstation-5-slim-1tb-console/19446111"   -> canonical URL
  seoText              "playstation-5-slim-1tb-console"
  sellerId             "bbyca" (first party) | numeric marketplace seller id
  isMarketplace, isOnlineOnly, isInStoreOnly, isPreorderable, isClearance   booleans
  productType          "REGULAR"
  categoryName, shortDescription, customerRating, customerRatingCount, ehf[]
```

Canonical URL: prefix `productUrl` with `https://www.bestbuy.ca`. It comes back
with a capital `/en-CA/`; the site serves lowercase `/en-ca/` and both work.

`isOnlineOnly` / `isMarketplace` are worth showing in the UI: such items have no
store pickup at all and the availability call will report `"OnlineOnly"`.

**Unknown SKU:** HTTP 200 with `{"currentPage":1,"total":0,"totalPages":1,"pageSize":20,"items":[]}`.
So `total === 0` / `items.length === 0` is the "item not found" signal. (The
availability endpoint does *not* distinguish an unknown SKU — see Errors — so
the catalog call is the authority.)

## 3. Store list near a postal code

```
GET /api/v3/json/locations?lang=en-CA&postalCode=M5V%203L9&pageSize=1000
```

Parameters:

- `postalCode` — required; anything else returns `total: 0`. Accepts a full
  postal code with or without the space and lowercase, and also a bare FSA
  (`M3L`) — that is what the site itself sends.
- `pageSize` — honoured, default 50. `pageSize=1000` returns everything in range
  in one page (`totalPages: 1`). `page=2` then returns an empty `locations` array.
- `lang` — `en-CA` / `fr-CA`.
- **No radius/lat-lng parameters.** `radius`, `maxDistance`, `lat`/`lng` and
  `latitude`/`longitude` are all silently ignored (or produce `total: 0` when
  `postalCode` is missing). The server applies its own ~50 km radius: `M5V 3L9`
  returns 53 locations out to 49.11 km; `Y1A 1A1` (Whitehorse) returns 1.

Response (see `test/fixtures/bestbuy-stores.json`):

```
Brand "BestBuyCanada", currentPage, pageSize, totalPages, total
locations[]:
  locationId       "259"                    -> Store.id  (this is the value for `locations=` in §1)
  name             "Best Buy Express Union Station"   -> Store.name
  address1         "220 Yonge Street"       -> street  (address2/line1/line2 are usually null)
  city             "Toronto"
  region           "ON"                     (province code)
  postalCode       "M5B 2H1"
  country          "CAN"
  lat              43.644833                -> latitude
  lng              -79.379433               -> longitude
  distance         0.56  (number, km, straight-line from the query postal code)
  type             "BigBox" | "SmallFormat" | "Mobile"
  format           "Regular Store" | "BBY Express Stores" | "Mobile Only Format" | "Web Store" | "Pop up Store" | "Other"
  warehouseId      "1006" for big-box stores, "-1" for express/small formats
  phone1..phone3, hours[] (strings, "Monday   10 AM - 8 PM"), timeZone, utcOffset
  services[]       {serviceCode, serviceName, serviceImageUri}
  qpu.pickupOptions  ["IN_STORE_PICKUP"] and/or ["CURBSIDE_PICKUP"]
  qpu.curbsidePickupLink, qpu.holdPolicy.{regularHoldInDays, specialHoldDates[]}
  productsAvailability  []   (always empty here; use §1 instead)
```

`locationId` — not `warehouseId` — is the id the availability endpoint keys on.
"BBY Express" small-format locations *are* returned by the availability call
(with `hasInventory:false` more often than not), so they are worth including.

### Can one call return every Best Buy store in Canada?

**No.** The endpoint is postal-code-centred with a fixed ~50 km radius and no way
to widen it. Two ways to get the whole country:

1. **Seeded sweep** (what walmart does): call `/api/v3/json/locations` once per
   seed postal code across Canada and dedupe on `locationId`. 6 metro postal
   codes (M5V/V6B/H3B/T2P/B3J/R3C) already yielded 161 distinct locations, and
   each response carries `lat`/`lng`, so the result is directly usable as a
   `stores-ca.json` equivalent.
2. **Store directory sitemap** (cheaper, no API load): `https://stores.bestbuy.ca/sitemap.xml`
   (Yext-hosted, 200, ~590 KB, `robots.txt` allows it) lists **315 English
   Canadian store pages** as `/en-ca/<province>/<city>/<street>`. That is the
   authoritative store count for Canada. Each page carries the address and
   coordinates. A build-time script analogous to `tools/build-store-list-pages.mjs`
   can turn this into the complete store list.

## 4. Errors

| Case | Status | Body signature |
|------|--------|----------------|
| Unknown SKU, catalog | 200 | `{"currentPage":1,"total":0,"totalPages":1,"pageSize":20,"items":[]}` |
| Unknown SKU, availability | 200 | a full `availabilities[0]` shell with the requested `sku`, `pickup.locations: []`, `pickup.purchasable:false`, `pickup.status:"NotAvailable"` — **indistinguishable from a legitimately unavailable item**, so validate the SKU with the catalog call |
| Invalid postal code, availability | **400** | `{"errorCode":"1102","errorMessage":"Invalid query parameter: getProductAvailability.postalCode: must match \"^$\|^[A-Za-z]\\d[A-Za-z]\\s?(\\d[A-Za-z]\\d)?$\"","timeStamp":"..."}` |
| Invalid postal code, store list | 200 | `{"Brand":"BestBuyCanada","currentPage":0,"pageSize":0,"totalPages":0,"total":0,"locations":[]}` |
| Too many `locations` (>=98) | 400 | `{"errorCode":"1103","errorMessage":"Invalid query parameter: getProductAvailability.locations: must match \"^$\|^\\d+(?:\\\|\\d+){0,96}$\"", "timeStamp":"..."}` |
| 97 `locations` | 400 | `{"timestamp":"...","path":"/api/v1/products","status":400,"error":"Bad Request","requestId":"..."}` (upstream, not the gateway) |
| Unknown product page | 200 HTML | product page 404s render the generic "Page introuvable / Page not found" shell — do not parse the page, use the catalog endpoint |
| Bot challenge | — | **never observed.** No PerimeterX/Akamai interstitial, no press-and-hold, on any of ~75 calls across page loads and direct fetches, with or without cookies |

The availability postal-code regex is `^$|^[A-Za-z]\d[A-Za-z]\s?(\d[A-Za-z]\d)?$`:
an FSA alone (`M5V`) is valid, the space is optional, lowercase is accepted, and
an empty string is accepted. Validate the user's postal code against this regex
client-side rather than round-tripping a 400.

### Rate limiting

**None found.** 40 consecutive `/ecomm-api/availability/products` calls, each
with 50 locations and a cache-busting parameter, 1 s apart (66 s wall clock) from
one IP: **40/40 HTTP 200, zero 429s.** No `Retry-After`, `x-ratelimit-*` or
Akamai `x-wca-reqrl` headers appear on any response. This is markedly more
permissive than walmart.ca (which 429s at ~25 calls). Still keep the extension's
calls spaced ~1 s and capped per user action — the absence of a limit today is
not a guarantee.

## 5. Tenant / vendor headers

There are none. No `x-o-*`, no `x-api-key`, no build-version pin, no persisted
query hash. The only vendor-specific token in the whole flow is the media-type
string `application/vnd.bestbuy.standardproduct.v1+json` passed as the `accept`
*query parameter*. Because nothing is tied to a site build, these endpoints
should not break the way walmart's hashed queries do.

## Other endpoints seen (not needed)

- `GET /api/v3/json/locations/locate?includeStores=false&lang=en-CA[&postalCode=M3L]`
  — geocodes a postal code to `{city, region, latitude, longitude, postalCode}`.
  Useful if a lat/lng for the user is ever wanted; not required.
- `GET /api/v2/json/search?...` (product search), `GET /api/v2/json/product/<sku>/conditions`,
  `GET /api/v3/products/<sku>/media`, `GET /api/offers/v1/products/<sku>/offers?postalCode=`,
  `GET /api/soc/v1/products/<sku>/special-offers`, `GET /api/merch/v1/*` — page chrome,
  media galleries, promos.
- `https://stores.bestbuy.ca/*` — Yext-hosted store directory (see §3).

## Search strategy

**Availability accepts 96 locations per call; full-country search = ceil(stores/96) calls.**

With 315 Canadian store pages in the directory, one SKU's pickup status at
**every** Best Buy in Canada costs **4 calls** (4 x 96 >= 315). Task 8 should
implement the batched pass, not walmart's outward-probing `lib/stock-search.js`:

1. Load the full store list (built offline from `stores.bestbuy.ca/sitemap.xml`,
   or from a seeded sweep of `/api/v3/json/locations`) with `locationId`, name,
   address, lat, lng.
2. Sort store ids by distance from the user's postal code (the nearby set and its
   `distance` values come from one `/api/v3/json/locations?postalCode=` call; the
   rest by haversine from the stored coordinates), so the first batch is the most
   likely to hit.
3. Issue `ceil(n/96)` availability calls, ~1 s apart, and stop at the first batch
   containing a `hasInventory: true` location.
4. Short-circuit when `pickup.status` is `"OnlineOnly"` or `"NotAvailable"` on the
   first batch — the item has no in-store pickup anywhere.
