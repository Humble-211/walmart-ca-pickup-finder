# Delivery Mode — Design

Date: 2026-09-16
Status: approved, not yet implemented
Builds on: `2026-09-15-multi-retailer-design.md`

## Goal

Let the user choose **Pickup** or **Delivery** before a lookup, and answer the
question they actually asked. The two answers differ: on walmart.ca, for one
item and one postal code, store 3635 is in stock for pickup and out of stock for
delivery, while stores 3740, 3111 and 1188 are the other way round. The delivery
query also reaches nodes the pickup query never returns (1801, 1150, 1803, 1151,
3000 — delivery-only nodes). A pickup answer therefore does not tell the user
whether the item can be delivered, and today the extension only answers pickup.

## Decisions (from brainstorming)

- **Result shape:** one answer for the postal code ("can it be delivered to me,
  how many, when"), with a store list as a fallback only where delivery is
  fulfilled from stores.
- **Mode is chosen before the search** (a radio next to the postal code), not a
  tab over a finished result. Only the chosen mode is fetched: it keeps the call
  count down on walmart.ca, which rate-limits hard.
- **Walmart needs no session change.** `nearByNodes` accepts
  `accessTypes: ["DELIVERY_ADDRESS"]` and answers per-node availability for a
  postal code, verified live. Changing the session's delivery address (the
  approach `setPickup` takes for pickup) is therefore not needed and not used.
- **No nationwide search in delivery mode.** A store 500 km away cannot deliver
  to the user, so the search space is the nodes that serve their postal code.

## Constraints

- Everything runs from the retailer's own tab, as today; the background worker
  owns the job (`src/lib/job.js`) and the popup only renders it.
- walmart.ca rate-limits `nearByNodes` (~25 calls in a few minutes → 429 with a
  growing penalty box). Delivery mode must not multiply calls: one call for the
  lookup, one more if the user asks to widen the search.
- Best Buy, Staples and Shoppers deliver from distribution centres. Their
  delivery answer is national: one call, no store list, nothing to widen.
- The pickup path must not change behaviour. It is the tested, shipped path.

## Evidence

Verified live on 2026-09-15/16 and recorded in the endpoint docs:

| Retailer | Delivery source | Per-node? | Postal-code aware? |
|----------|-----------------|-----------|--------------------|
| Walmart | `nearByNodes` `accessTypes: ["DELIVERY_ADDRESS"]`, `checkItemAvailability: true` | yes (`product.availabilityStatus` per node) | yes (`input.postalCode`) |
| Best Buy | `shipping` block of the availability call already made | no | yes (`postalCode` query parameter) |
| Staples | inventory endpoint, `location` = the postal code, `is_dropship: true` | no | yes (dates change: Sep 22 for M5V 3L9, Sep 17 for Y1A 1A1) |
| Shoppers | `fulfillment-options?storeId=&postalCode=` | no | yes (1-3 business days for M5V 3L9, 10-16 for Y1A 1A1) |

Other `NodeAccessType` values tried on walmart.ca — `DELIVERY`,
`HOME_DELIVERY`, `SCHEDULED_DELIVERY` — are rejected by the schema with
`invalid input value at $input.accessTypes[0]`, the same error as a garbage
control value. `DELIVERY_ADDRESS` is the only one that works.

## Architecture

```
popup
  mode radio (pickup | delivery), remembered in chrome.storage.local
  sendMessage({ type: "startJob", retailer, itemId, postalCode, mode })
     v
background (src/lib/job.js)
  job.mode decides what the job does after the lookup:
    pickup   -> lookup, then the nationwide search, as today
    delivery -> lookup only; the answer is complete in one call
  forwards { type, retailer, mode, ... } to the retailer's content script
     v
content script for that retailer
  lookup   { itemId, postalCode, mode } -> { item, stores }
  findInStock { ..., mode }             -> SearchResult
```

Nothing in the message envelope changes except the added `mode`. A content
script that receives a mode it cannot serve answers
`{ ok: false, code: "unsupported" }`, which the popup already knows how to show.

## Shared types

```
Item    { id, name, priceString, imageUrl, url, retailer, pickupEligible,
          delivery: { status, quantity, eta } | null }     // unchanged
Store   { id, name, address, postalCode, distanceKm | null,
          status: "available" | "out_of_stock" | "unknown", url,
          accessPointId? }                                  // unchanged
Job     { ..., mode: "pickup" | "delivery" }                // mode added
```

In delivery mode `Store.status` means "in stock for delivery from this node" and
`Store.distanceKm` is the node's distance from the postal code, which is what
orders the list. `Item.delivery` keeps its meaning from the delivery line
shipped on 2026-09-15: the one answer for the postal code.

## Per-retailer behaviour

**Walmart.** `lookup` with `mode: "delivery"` calls `nearByNodes` with
`accessTypes: ["DELIVERY_ADDRESS"]` and `maxCount: 10`, and maps the nodes
exactly as the pickup path does, and answers `complete: false` because the node
count can still be widened. `item.delivery` is derived from those nodes:
`available` when any node is `IN_STOCK`, `out_of_stock` when at least one node
reports a status and none is in stock, `unknown` when no node reports one;
`quantity` is null (walmart reports no count) and
`eta` is null (no per-postal-code date without touching the session). The
returned `stores` are the delivery nodes. `findInStock` with `mode: "delivery"`
re-runs the same call with `maxCount: 50` — one call, no outward probing — and
reports `complete: true` afterwards, because nothing beyond those nodes serves
the address. Store rows carry no `accessPointId` in delivery mode, so the popup
cannot offer "Order pickup" for them.

**Best Buy, Staples, Shoppers.** `lookup` with `mode: "delivery"` makes the
delivery call these adapters already make (`parseShipping`, `getDelivery`,
`getDelivery`) and returns `{ item, stores: [], complete: true }` — the item
carries the answer and nothing can improve it.
The pickup-only calls (store list, per-store availability) are skipped, so a
delivery lookup is cheaper than a pickup one. `findInStock` with
`mode: "delivery"` answers `{ ok: true, inStock: [], searched: 0, checkedIds: [],
complete: true }`: there is nothing to search, and the popup says so rather than
spinning.

## Job

`start({ retailer, itemId, postalCode, mode, input })` stores `mode` on the job.
After a successful lookup:

- `mode === "pickup"`: unchanged — `shouldSearch(item, nearby)` decides whether
  the nationwide search runs.
- `mode === "delivery"`: the job goes straight to `done`, and records the lookup
  response's `complete` flag as `job.search = { searched: stores.length,
  remaining: 0, complete, rateLimited: false, noLocation: false }`. That is what
  the popup already reads to decide whether to offer "Keep searching farther":
  hidden for the three national adapters (`complete: true`), offered for walmart
  until the widened call has run. Pressing it reaches `findInStock` with the
  mode, which widens walmart's node count and then reports `complete: true`.

`recover()` and the supersede rules are untouched.

## Popup

- A **Pickup / Delivery** radio pair sits under the postal code, remembered in
  `chrome.storage.local` next to the postal code. Changing it does not re-run
  anything; the next search uses it.
- **Delivery mode, no node list** (Best Buy, Staples, Shoppers): the item card,
  the delivery line, and nothing else. When the item cannot be delivered, the
  status line says so plainly: "This item cannot be delivered to M5V 3L9."
- **Delivery mode with nodes** (Walmart): the item card, the delivery line, then
  a **Delivers from** list of the in-stock nodes, nearest first, and "Keep
  searching farther" while the widened call has not run.
- Store-row buttons in delivery mode always read "Open product page".
- Pickup mode is unchanged, delivery line included: it is what tells the user
  the other mode is worth a try. Walmart shows no line there, because its pickup
  lookup does not fetch delivery and an extra call on a rate-limited endpoint is
  not worth it.

## Error handling

Unchanged codes and wire shape. A retailer that cannot answer the chosen mode
answers `unsupported`. A walmart 429 during a delivery lookup maps to
`rate_limited` exactly as in pickup. An unknown postal code still maps to
`invalid_postal`.

## Testing

- **Unit:** `mode` is stored on the job and decides whether the search phase runs
  (`test/job.test.js`); walmart's request builder emits `DELIVERY_ADDRESS` and
  the right `maxCount`; walmart's delivery summary is derived from the node list
  (all three status cases); the three national adapters answer a delivery lookup
  with an empty store list and a complete `findInStock`; the popup's
  delivery-mode wording lives in `src/lib/delivery.js` and is tested there.
- **End-to-end:** `tools/e2e-popup.mjs` gains a mode per scenario
  (`"<url>|<postal>|delivery"`). Scenarios: one item per retailer in delivery
  mode, and the walmart item where pickup and delivery disagree, asserting the
  two modes really do produce different store lists.

## Out of scope

Same-day delivery from Staples or Shoppers stores (no endpoint found for it),
walmart's ship-from-warehouse view (session-bound), delivery fees and carriers,
showing both modes at once, and GameStop.
