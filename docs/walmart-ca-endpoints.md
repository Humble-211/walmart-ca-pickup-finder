# walmart.ca internal endpoints (discovered 2026-09-15)

All calls are GraphQL persisted queries under `https://www.walmart.ca/orchestra/`.
They only succeed from a page on `www.walmart.ca` with the user's cookies
(`credentials: "include"`) after the PerimeterX "press and hold" challenge has
been passed in that browser. Query hashes are tied to the site build
(`x-o-platform-version: caweb-1.173.1`); if Walmart ships a new query version
the hash changes and requests return 400. Re-discover with `tools/capture.js`.

Fixtures cut from real responses: `test/fixtures/nearByNodes.json`,
`test/fixtures/itemById.json`.

## Common headers

Tested by removing each header individually against `nearByNodes`:

| Header | Value | Required |
|--------|-------|----------|
| `x-o-bu` | `WALMART-CA` | yes (else "Node Type PICKUP_POPUP is not supported") |
| `x-o-mart` | `B2C` | yes (400) |
| `x-o-segment` | `oaoh` | yes (200 with empty data / "unknown error"; setPickup says "Missing required header x-o-segment") |
| `x-apollo-operation-name` | operation name | yes (400; also satisfies the CSRF check) |
| `content-type` | `application/json` | send anyway (CSRF check needs this or `x-apollo-operation-name`) |
| `x-o-platform` | `rweb` | optional |
| `x-o-gql-query` | `query nearByNodes` etc. | optional |
| `accept`, `wm_mp`, `x-o-ccm` | as site sends | optional |

Send the full set; cost is nothing and it matches what the site sends.

## 1. Stores near a postal code, with per-store item availability

```
GET /orchestra/graphql/nearByNodes/d26e41479a06dc27775a042b88b74ea8b5b75d3a670bcafd080eb7a4e2bdf66f
    ?variables=<urlencoded JSON>
```

Variables (all top-level booleans are `Boolean!` and must be present):

```json
{
  "input": {
    "postalCode": "M1P 4P5",
    "accessTypes": ["PICKUP_INSTORE", "PICKUP_CURBSIDE"],
    "nodeTypes": ["STORE", "PICKUP_SPOKE", "PICKUP_POPUP"],
    "latitude": null, "longitude": null, "radius": null,
    "productId": "6000208927194",
    "maxCount": 10
  },
  "checkItemAvailability": true,
  "checkWeeklyReservation": false,
  "enableStoreSelectorMarketplacePickup": false,
  "enableVisionStoreSelector": false,
  "enableStorePagesAndFinderPhase2": false,
  "enableStoreBrandFormat": false,
  "disableNodeAddressPostalCode": false,
  "enableWICStoreSelector": false,
  "enableSparkStore": false
}
```

Notes:
- `productId` is the item ID from the product URL (`/en/ip/<slug>/<id>` or `/ip/<id>`). Two forms exist and both are accepted here and by ItemById: numeric `6000208927194` and 12-character alphanumeric `1SZQHN3LOSE0` (verified 2026-09-15 with the PS5 Pro console, which has no numeric ID).
- `checkItemAvailability: true` adds `product { availabilityStatus }` per node
  and removes `geoPoint` (query text: `geoPoint @skip(if:$checkItemAvailability)`).
- `maxCount` must be 5..50 (HTTP 200 with `errors[].extensions.entityErrors[].info: "maxCount must be between 5 and 50"` otherwise). Without `productId`/`maxCount` the call returns 50 stores, no availability.
- `latitude`/`longitude` (numbers) may replace the postal code (`postalCode: null`); when both are sent the point wins. `radius` is in km and must be 1..100 (`SEARCH_RADIUS_BETWEEN_5_AND_100` otherwise). With `radius: null` a default of roughly 30-50 km applies (Vancouver: 18 stores, farthest 30.5 km, vs 30 stores out to 87 km with `radius: 100`; Yellowknife's postal code returns only its own store). So one call never reaches beyond 100 km, which is why covering Canada takes ~57 calls.
- A point with no pickup node in range answers HTTP 200 with `data.nearByNodes: null` and `errors[0].message: "SERVICE_UNAVAILABLE"` (`extensions.code: "400.204"`, "No access point ..."). `parseStores` maps it to an empty list.
- `distance` is straight-line km from the query point, not driving distance.
- With `checkItemAvailability: false` each node carries `geoPoint {latitude, longitude}`; `tools/build-store-list.mjs` uses that to build `src/retailers/walmart/stores-ca.json` (pickup nodes in Canada with coordinates), which the nationwide in-stock search (`lib/stock-search.js`) uses to plan probes outward from the user. Because of the rate limit below, the faster way to complete the list is `tools/build-store-list-pages.mjs`: store pages (`/en/store/<id>`, ~180 KB each) carry JSON-LD `geo` coordinates and link to the 3 nearest stores, and are not rate-limited like the API. The current list (355 stores, generated 2026-09-15) came from an API run seeded with ~70 cities followed by the page crawl.
- The site's own store selector asks for 8 stores (`maxCountOfStoresForInventory: 8`). There is no endpoint that reports one item's stock across all stores (the bundle's only store-availability query is `nearByNodes`), so finding the nearest in-stock store means repeated `nearByNodes` calls around points.
- Rate limit (Akamai, header `x-wca-reqrl: glass_spa_standard_holiday.json`): about 25 `nearByNodes` calls within a few minutes from one IP get HTTP 429 with an empty body. The first block cleared in ~2-4 minutes; after repeated bursts it lasted 10+ minutes (looks like a penalty box that grows with each violation). It is per IP, not per profile/cookie jar (a second Chrome profile was blocked at the same time). Mapped to `rate_limited`. The nationwide search is capped at 10 calls, 1 s apart, per click; `tools/build-store-list.mjs` spaces its calls 25 s apart.
- Postal code is accepted with or without space and in lowercase (`m1p4p5`).
- Invalid postal code: HTTP 200, `data.nearByNodes: null`, `errors[0].message: "INVALID_POSTAL_CODE"`.
- Source: query text found in `_next/static/chunks/71433-*.js`, module `113362`
  (hook builds `Q.input.productId = C; Q.input.maxCount = W; Q.checkItemAvailability = true`).

Response fields used:

```
data.nearByNodes.nodes[]:
  id                     "3635"                -> Store.id
  displayName            "Scarborough Central" -> Store.name
  name                   "Walmart Supercenter"
  distance               "0.07"                (string, km) -> Store.distanceKm
  address.{addressLineOne, city, state, postalCode}
  displayAccessTypes     ["PICKUP_CURBSIDE","PICKUP_EXPRESS","PICKUP_INSTORE"]
  capabilities[]         {accessPointId, accessPointType, isActive}  -> needed for setPickup
  operationalHours[]     {day, start, end, closed}
  product.availabilityStatus   "IN_STOCK" | "OUT_OF_STOCK" | null
```

Status mapping: `IN_STOCK` -> available, `OUT_OF_STOCK` -> out_of_stock, anything else / missing -> unknown.

## 2. Product name, price, image

```
GET /orchestra/pdp/graphql/ItemById/dd90c309e2b4c9418dc5050720b5f8c8520e593aaf942fd2c7f6321ea820d500/ip/<itemId>
    ?variables=<urlencoded JSON>
```

Minimal variables that return a product (found by feeding back "missing variable" errors):

```json
{"iId":"6000208927194","tenant":"CA_GLASS","channel":"WWW","version":"v1",
 "pageType":"ItemPageGlobalDesktop","isMobile":false,"postProcessingVersion":1,
 "fRev":false,"spSBA":false,"sVC":false,"enableImageClassification":false,"adV1Enabled":false,
 "eItIb":false,"fIlc":false,"enableDetailedBeacon":false,"fSeo":false,"fP13":false,"sV":false,
 "spVid":false,"fGalAd":false,"fMrkDscrp":false,"fSCar":false,"fBB":false,"eSb":false,"sIdml":false,
 "eLLBBAds":false,"fBBAd":false,"enableTopReasonsToBuy":false,"fFit":false,"fIdml":false,"fSL":false,
 "eCc":false,"fSId":false,"fMq":false,"eSsm":false,"fAff":false,"enableRelatedSearch":false,"fDac":false}
```

Response fields used:

```
data.product.name
data.product.canonicalUrl                  "/en/ip/Bounty-.../6000208927194"
data.product.priceInfo.currentPrice.price  21.98 (CAD)
data.product.priceInfo.currentPrice.priceString "$21.98"
data.product.imageInfo.thumbnailUrl
data.product.availabilityStatus            "IN_STOCK" (online)
data.product.pickupOption.availabilityStatus  "AVAILABLE" | null  (null = item not pickup-eligible at all)
data.product.availableFulfillmentOptions   e.g. ["SCHEDULED_PICKUP","UNSCHEDULED_PICKUP",...]
```

Unknown item ID: HTTP 200 with a `data.product` object whose `name` and `usItemId`
are `""` and `id`/`canonicalUrl` are null (an empty shell, not `null`) -> user-facing
"Item not found". `parseItem` also treats a literal `null` product the same way.

## 3. Select a pickup store (for the "Order pickup" button)

```
POST /orchestra/graphql/setPickup/6a6546328078a19211cd19fa5cc944c0ab3391debe1921175575027f42fcb726
body: {"variables": {...}}
```

Minimal body that works (verified: response `fulfillment.pickupStore.storeId` equals requested store):

```json
{"variables":{"input":{
  "accessPointId":"<capabilities[].accessPointId of the chosen store, type PICKUP_INSTORE or PICKUP_CURBSIDE>",
  "cartId":"00000000-0000-0000-0000-000000000000",
  "postalCode":"M1P 4P5",
  "storeId":3635,
  "enableLiquorBox":false,"enableCartSplitClarity":true,"features":["lmpdel"]}}}
```

`storeId` is a number here (string elsewhere). The site sends 124 variables; only
`input` is required. After this call the store is persisted in the session, so the
product page (`https://www.walmart.ca` + `canonicalUrl`) shows the chosen store's
pickup option.

Side effect: changes the user's selected store on walmart.ca for the whole session.
The extension only calls it when the user clicks "Order pickup" for a store.

## Not needed

`setFulfillmentIntent` (mutation, sets PICKUP/DELIVERY tab preference): not required
for the flow above. `GlobalIntentCenter`, `Header`, `HomePage*`, `IntlAdV2`: page chrome and ads.

## Delivery

`nearByNodes` answers delivery the same way it answers pickup: send
`accessTypes: ["DELIVERY_ADDRESS"]` with `checkItemAvailability: true` and a
postal code, and each node comes back with `product.availabilityStatus` for
delivery. It needs no session change, unlike `setPickup`. `DELIVERY_ADDRESS` is
the only delivery access type the schema takes: `DELIVERY`, `HOME_DELIVERY` and
`SCHEDULED_DELIVERY` are all rejected with `invalid input value at
$input.accessTypes[0]`, the same error a garbage value gets.

The two fulfillment types really do differ. One item, `M5V 3L9`, `maxCount: 50`:
store 3635 is `IN_STOCK` for pickup and `OUT_OF_STOCK` for delivery; 3740, 3111
and 1188 are the reverse. The delivery query also returns nodes the pickup query
never does (1801, 1150, 1803, 1151, 3000). A rural postal code (`K0J 1J0`)
returns the same single node either way.

`ItemById` also carries `shippingOption`, `fulfillmentSummary[]` and
`fulfillmentLabel[]`, but those describe shipping to the address saved in the
user's session, not to a postal code, so the adapter does not use them.
