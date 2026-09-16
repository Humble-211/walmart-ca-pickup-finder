# Delivery Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user pick Pickup or Delivery before a lookup and get the answer for that fulfillment type, because the two differ per store (walmart.ca, one item, one postal code: store 3635 is in stock for pickup and out of stock for delivery, store 3740 the other way round).

**Architecture:** `mode: "pickup" | "delivery"` travels from a radio in the popup, through the background job, to each retailer's content script, which branches on it. The pickup path is untouched. In delivery mode the lookup is the whole answer: walmart asks `nearByNodes` with `accessTypes: ["DELIVERY_ADDRESS"]` and returns per-node stock, while Best Buy, Staples and Shoppers return only `item.delivery` (their delivery is national). No nationwide search runs in delivery mode.

**Tech Stack:** Chrome MV3, ES modules, esbuild, vitest 2, Node 24+.

**Spec:** `docs/superpowers/specs/2026-09-16-delivery-mode-design.md` (binding) plus the endpoint docs `docs/walmart-ca-endpoints.md`, `docs/bestbuy-ca-endpoints.md`, `docs/staples-ca-endpoints.md`, `docs/shoppers-ca-endpoints.md` (authoritative for field names and limits).

## Global Constraints

- Shared shapes stay as they are; only `Job` gains a field: `Job { ..., mode: "pickup" | "delivery" }`. `Item { id, name, priceString, imageUrl, url, retailer, pickupEligible, delivery: { status, quantity, eta } | null }`. `Store { id, name, address, postalCode, distanceKm | null, status: "available" | "out_of_stock" | "unknown", url, accessPointId? }`. `SearchResult { inStock, searched, checkedIds, complete, rateLimited, noLocation? }`.
- Error codes unchanged: `no_tab`, `verification`, `invalid_postal`, `not_found`, `api_changed`, `rate_limited`, `unsupported`, `unknown`. Messages are `{host}`/`{label}`/`{stores}` templates the popup fills in.
- Every retailer call runs inside that retailer's content script. Walmart uses `credentials: "include"`; Staples uses `"omit"`; Shoppers uses `"include"` plus its `x-apikey`.
- walmart.ca rate-limits `nearByNodes` at roughly 25 calls per five minutes per browser, with a penalty box that grows on repeat. Delivery mode must cost one call per lookup and at most one more when the user widens.
- The only walmart `NodeAccessType` for delivery is `DELIVERY_ADDRESS`. `DELIVERY`, `HOME_DELIVERY` and `SCHEDULED_DELIVERY` are rejected by the schema with `invalid input value at \`$input.accessTypes[0]\``.
- Delivery mode never starts the nationwide outward search (`src/lib/stock-search.js`); a store that far away cannot deliver to the user.
- Tests: `npx vitest run`. Build: `npm run build`. End-to-end: `node tools/e2e-popup.mjs` (needs `npm run build` first).
- New files use LF. Existing files in this repo are CRLF in the working tree: run `sed -i 's/\r$//' <file>` before a multi-line edit, as earlier tasks in this repo did.
- Commit after every task, with the trailer `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`. Do not push.

---

## File structure

```
src/lib/job.js                     + job.mode; delivery jobs skip the search phase and record `complete`
src/lib/delivery.js                + deliveryModeStatus(): the popup's wording when nothing can be delivered
src/popup/popup.html               + the Pickup/Delivery radio pair
src/popup/popup.css                + .modes styling
src/popup/popup.js                 + read/remember the mode, render delivery mode (headings, no pickup button)
src/background.js                  (unchanged: mode rides along inside the message)
src/retailers/walmart/api.js       + accessTypes argument on buildNearByNodesUrl; findDeliveryStores()
src/retailers/walmart/parse.js     + deliverySummary(stores) -> Item.delivery
src/retailers/walmart/content.js   + branch lookup/findInStock on msg.mode
src/retailers/bestbuy/content.js   + delivery-mode lookup (delivery only) and a complete findInStock
src/retailers/staples/content.js   + same
src/retailers/shoppers/content.js  + same
tools/e2e-popup.mjs                + a third field per scenario: the mode
test/job.test.js, test/delivery.test.js, test/walmart-api.test.js,
test/walmart-parse.test.js, test/bestbuy-api.test.js  (+ cases)
```

---

### Task 1: Walmart request builder and delivery store fetch

**Files:**
- Modify: `src/retailers/walmart/api.js` (`buildNearByNodesUrl`, new `findDeliveryStores`)
- Test: `test/walmart-api.test.js`

**Interfaces:**
- Produces: `buildNearByNodesUrl(postalCode, itemId, maxCount = 10, geo = null, accessTypes = ["PICKUP_INSTORE", "PICKUP_CURBSIDE"])`; `findDeliveryStores(postalCode, itemId, maxCount = 10) -> Store[]` (same shape `findStores` returns).

- [ ] **Step 1: Write the failing test**

Append to `test/walmart-api.test.js`:

```js
describe("delivery access types", () => {
  it("defaults to the pickup access types", () => {
    const vars = JSON.parse(decodeURIComponent(buildNearByNodesUrl("M5V 3L9", "1", 10).split("variables=")[1]));
    expect(vars.input.accessTypes).toEqual(["PICKUP_INSTORE", "PICKUP_CURBSIDE"]);
  });
  it("asks for DELIVERY_ADDRESS nodes when told to", () => {
    const vars = JSON.parse(decodeURIComponent(buildNearByNodesUrl("M5V 3L9", "1", 50, null, ["DELIVERY_ADDRESS"]).split("variables=")[1]));
    expect(vars.input.accessTypes).toEqual(["DELIVERY_ADDRESS"]);
    expect(vars.input.postalCode).toBe("M5V 3L9");
    expect(vars.input.maxCount).toBe(50);
    expect(vars.checkItemAvailability).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/walmart-api.test.js`
Expected: FAIL — the delivery case gets `["PICKUP_INSTORE","PICKUP_CURBSIDE"]` because the fifth argument is ignored.

- [ ] **Step 3: Write the implementation**

In `src/retailers/walmart/api.js`, replace the signature and the `accessTypes` line of `buildNearByNodesUrl`:

```js
// Either a postal code (geo = null) or a point: geo = {lat, lon, radiusKm}.
// Walmart accepts maxCount 5..50 and radius 1..100 km; a point overrides the postal code.
// accessTypes selects the fulfillment type: the pickup pair, or ["DELIVERY_ADDRESS"] for
// delivery (the only delivery NodeAccessType the schema accepts —
// docs/walmart-ca-endpoints.md).
export const PICKUP_ACCESS_TYPES = ["PICKUP_INSTORE", "PICKUP_CURBSIDE"];
export const DELIVERY_ACCESS_TYPES = ["DELIVERY_ADDRESS"];

export function buildNearByNodesUrl(postalCode, itemId, maxCount = 10, geo = null, accessTypes = PICKUP_ACCESS_TYPES) {
```

and inside the `input` object change `accessTypes: ["PICKUP_INSTORE", "PICKUP_CURBSIDE"],` to `accessTypes,`.

Then add, next to `findStores`:

```js
// The maxCount delivery nodes serving postalCode, with this item's delivery availability.
export async function findDeliveryStores(postalCode, itemId, maxCount = 10) {
  return parseStores(await gql(buildNearByNodesUrl(postalCode, itemId, maxCount, null, DELIVERY_ACCESS_TYPES), "nearByNodes"));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/walmart-api.test.js`
Expected: PASS, including every pre-existing test in that file (the default argument keeps pickup callers unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/retailers/walmart/api.js test/walmart-api.test.js
git commit -m "feat: walmart nearByNodes takes an access type, plus a delivery store fetch"
```

---

### Task 2: Walmart delivery summary

**Files:**
- Modify: `src/retailers/walmart/parse.js` (new export `deliverySummary`)
- Test: `test/walmart-parse.test.js`

**Interfaces:**
- Consumes: the `Store[]` shape `parseStores` already returns.
- Produces: `deliverySummary(stores) -> { status: "available" | "out_of_stock" | "unknown", quantity: null, eta: null }`.

- [ ] **Step 1: Write the failing test**

Append to `test/walmart-parse.test.js`:

```js
describe("deliverySummary", () => {
  const store = (id, status) => ({ id, name: id, address: "", postalCode: "", distanceKm: 1, status, url: null });
  it("is available when any delivery node has the item", () => {
    expect(deliverySummary([store("a", "out_of_stock"), store("b", "available")])).toEqual({ status: "available", quantity: null, eta: null });
  });
  it("is out of stock when every node is known and none has it", () => {
    expect(deliverySummary([store("a", "out_of_stock"), store("b", "out_of_stock")]).status).toBe("out_of_stock");
  });
  it("is unknown when no node reports a status, or there are no nodes at all", () => {
    expect(deliverySummary([store("a", "unknown")]).status).toBe("unknown");
    expect(deliverySummary([]).status).toBe("unknown");
  });
});
```

Add `deliverySummary` to the existing import from `../src/retailers/walmart/parse.js` at the top of that file.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/walmart-parse.test.js`
Expected: FAIL with `deliverySummary is not a function`.

- [ ] **Step 3: Write the implementation**

Append to `src/retailers/walmart/parse.js`:

```js
// Delivery nodes -> the Item.delivery summary. Walmart reports no count and no
// per-postal-code date for delivery, so only the status is real.
export function deliverySummary(stores) {
  const known = stores.filter((s) => s.status !== "unknown");
  const status = stores.some((s) => s.status === "available") ? "available" : known.length ? "out_of_stock" : "unknown";
  return { status, quantity: null, eta: null };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/walmart-parse.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/retailers/walmart/parse.js test/walmart-parse.test.js
git commit -m "feat: derive walmart's delivery summary from its delivery nodes"
```

---

### Task 3: Walmart content script answers delivery mode

**Files:**
- Modify: `src/retailers/walmart/content.js`
- Test: `test/walmart-content.test.js` (create)

**Interfaces:**
- Consumes: `findDeliveryStores(postalCode, itemId, maxCount)` (Task 1), `deliverySummary(stores)` (Task 2).
- Produces: `handleMessage(msg, deps) -> response`, exported so tests can drive it without `chrome`. `deps = { getItem, findStores, findDeliveryStores, findInStock, selectStore, rankStores }`, each defaulting to the module's real implementation.

- [ ] **Step 1: Write the failing test**

Create `test/walmart-content.test.js`:

```js
import { describe, it, expect, vi } from "vitest";
import { handleMessage } from "../src/retailers/walmart/content.js";

const item = { id: "1", name: "Thing", url: "https://www.walmart.ca/en/ip/1", retailer: "walmart", pickupEligible: true };
const store = (id, status) => ({ id, name: id, address: "", postalCode: "", distanceKm: Number(id), status, url: null, accessPointId: "ap" + id });

describe("walmart delivery mode", () => {
  it("looks up delivery nodes and summarises them, without touching the pickup store list", async () => {
    const deps = {
      getItem: vi.fn(async () => item),
      findStores: vi.fn(),
      findDeliveryStores: vi.fn(async () => [store("2", "out_of_stock"), store("1", "available")]),
    };
    const res = await handleMessage({ type: "lookup", itemId: "1", postalCode: "M5V 3L9", mode: "delivery" }, deps);
    expect(deps.findStores).not.toHaveBeenCalled();
    expect(deps.findDeliveryStores).toHaveBeenCalledWith("M5V 3L9", "1", 10);
    expect(res.item.delivery).toEqual({ status: "available", quantity: null, eta: null });
    expect(res.stores.map((s) => s.id)).toEqual(["1", "2"]); // ranked by distance
    expect(res.complete).toBe(false); // the node count can still be widened
  });

  it("widens the node count on findInStock and then reports complete", async () => {
    const deps = {
      findDeliveryStores: vi.fn(async () => [store("1", "available"), store("2", "out_of_stock")]),
    };
    const res = await handleMessage({ type: "findInStock", itemId: "1", postalCode: "M5V 3L9", mode: "delivery", nearby: [] }, deps);
    expect(deps.findDeliveryStores).toHaveBeenCalledWith("M5V 3L9", "1", 50);
    expect(res.inStock.map((s) => s.id)).toEqual(["1"]);
    expect(res.complete).toBe(true);
    expect(res.checkedIds).toEqual(["1", "2"]);
  });

  it("leaves pickup mode alone", async () => {
    const deps = {
      getItem: vi.fn(async () => item),
      findStores: vi.fn(async () => [store("1", "available")]),
      findDeliveryStores: vi.fn(),
    };
    const res = await handleMessage({ type: "lookup", itemId: "1", postalCode: "M5V 3L9", mode: "pickup" }, deps);
    expect(deps.findStores).toHaveBeenCalledWith("M5V 3L9", "1", 10);
    expect(deps.findDeliveryStores).not.toHaveBeenCalled();
    expect(res.item.delivery).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/walmart-content.test.js`
Expected: FAIL — `handleMessage` is not exported (the module currently has a private `handle`).

- [ ] **Step 3: Write the implementation**

In `src/retailers/walmart/content.js`, add `findDeliveryStores` to the import from `./api.js` and `deliverySummary` to the import from `./parse.js` (add the import line if the file has none yet):

```js
import { getItem, findStores, findDeliveryStores, findStoresAround, selectStore } from "./api.js";
import { deliverySummary } from "./parse.js";
```

Add the delivery node counts next to `MAX_STORES`:

```js
// Delivery is served by the nodes around the postal code; there is nothing farther to probe,
// so "keep searching" just widens the one call (walmart caps maxCount at 50).
const DELIVERY_STORES = 10;
const DELIVERY_STORES_WIDE = 50;
```

Replace the private `handle` with an exported, injectable one. Keep the existing pickup branches exactly as they are:

```js
// deps are injected so tests can drive this without the network or chrome.
export async function handleMessage(msg, deps = {}) {
  const api = { getItem, findStores, findDeliveryStores, findInStock, selectStore, rankStores, ...deps };
  switch (msg?.type) {
    case "ping":
      return { ok: true };
    case "lookup": {
      if (msg.mode === "delivery") {
        const [item, stores] = await Promise.all([
          api.getItem(msg.itemId),
          api.findDeliveryStores(msg.postalCode, msg.itemId, DELIVERY_STORES),
        ]);
        const ranked = api.rankStores(stores);
        return { ok: true, item: { ...item, delivery: deliverySummary(ranked) }, stores: ranked, complete: false };
      }
      const [item, stores] = await Promise.all([
        api.getItem(msg.itemId),
        api.findStores(msg.postalCode, msg.itemId, MAX_STORES),
      ]);
      return { ok: true, item, stores: api.rankStores(stores) };
    }
    case "findInStock": {
      if (msg.mode === "delivery") {
        const stores = api.rankStores(await api.findDeliveryStores(msg.postalCode, msg.itemId, DELIVERY_STORES_WIDE));
        return {
          ok: true, inStock: stores.filter((s) => s.status === "available"), searched: stores.length,
          checkedIds: stores.map((s) => s.id), complete: true, rateLimited: false,
        };
      }
      if (!Array.isArray(msg.nearby)) return { ok: false, code: "unknown", error: "findInStock needs the nearby store list." };
      return { ok: true, ...(await api.findInStock(msg)) };
    }
    case "selectStore": {
      const { storeId } = await api.selectStore(msg.store, msg.postalCode);
      return { ok: true, storeId };
    }
    default:
      return { ok: false, code: "unknown", error: `Unknown message type: ${msg?.type}` };
  }
}
```

and point the listener at it:

```js
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handleMessage(msg).then(sendResponse, (err) => sendResponse(toErrorResponse(err)));
  return true; // keep the channel open for the async response
});
```

The module already imports `rankStores`; leave that import in place.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run`
Expected: PASS, whole suite.

- [ ] **Step 5: Commit**

```bash
git add src/retailers/walmart/content.js test/walmart-content.test.js
git commit -m "feat: walmart content script answers delivery mode from DELIVERY_ADDRESS nodes"
```

---

### Task 4: The three national adapters answer delivery mode

**Files:**
- Modify: `src/retailers/bestbuy/content.js`, `src/retailers/staples/content.js`, `src/retailers/shoppers/content.js`
- Test: `test/bestbuy-api.test.js` (one case proving an availability call is not needed for delivery)

**Interfaces:**
- Consumes: `parseShipping` via `api.getAvailability(sku, [], postalCode).delivery` (Best Buy), `api.getDelivery(sku, postalCode)` (Staples), `api.getDelivery(code, postalCode)` (Shoppers) — all shipped already.
- Produces: for `mode: "delivery"`, `lookup -> { ok: true, item: { ...item, delivery }, stores: [], complete: true }` and `findInStock -> { ok: true, inStock: [], searched: 0, checkedIds: [], complete: true, rateLimited: false }`.

- [ ] **Step 1: Write the failing test**

Append to `test/bestbuy-api.test.js`:

```js
describe("delivery without stores", () => {
  it("answers shipping for a postal code with no locations at all", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(readFileSync(new URL("./fixtures/bestbuy-availability.json", import.meta.url), "utf8"), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const { delivery, statuses } = await getAvailability("19446111", [], "M5V 3L9");
      expect(delivery.status).toBe("available");
      expect(statuses.size).toBe(0);
      expect(fetchMock.mock.calls[0][0]).toContain("locations=&");
    } finally { vi.unstubAllGlobals(); }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails or passes**

Run: `npx vitest run test/bestbuy-api.test.js`
Expected: PASS already — the empty-locations call is supported (documented in `docs/bestbuy-ca-endpoints.md`). This test pins the behaviour the delivery branch depends on. If it fails, stop and fix `buildAvailabilityUrl` before continuing.

- [ ] **Step 3: Write the implementation**

In `src/retailers/bestbuy/content.js`, inside `handle`, make `lookup` and `findInStock` branch first:

```js
    case "lookup": {
      if (msg.mode === "delivery") {
        const [item, { delivery }] = await Promise.all([api.getItem(msg.itemId), api.getAvailability(msg.itemId, [], msg.postalCode)]);
        return { ok: true, item: { ...item, delivery }, stores: [], complete: true };
      }
```

(leave the rest of the `lookup` body as it is), and at the top of `findInStock`:

```js
    case "findInStock": {
      // Best Buy ships from distribution centres: there is no farther store to try.
      if (msg.mode === "delivery") return { ok: true, inStock: [], searched: 0, checkedIds: [], complete: true, rateLimited: false };
```

In `src/retailers/staples/content.js`, the same two branches, using the staples calls:

```js
    case "lookup": {
      const sku = skuOf(msg.itemId);
      if (msg.mode === "delivery") {
        const [item, delivery] = await Promise.all([api.getItem(msg.itemId), api.getDelivery(sku, msg.postalCode)]);
        return { ok: true, item: { ...item, delivery }, stores: [], complete: true };
      }
```

(the existing `const sku = skuOf(msg.itemId);` line moves up if it is not already first), and:

```js
    case "findInStock": {
      // Staples ships from distribution centres: there is no farther store to try.
      if (msg.mode === "delivery") return { ok: true, inStock: [], searched: 0, checkedIds: [], complete: true, rateLimited: false };
```

In `src/retailers/shoppers/content.js`, the same, noting that its lookup resolves the variant code first:

```js
    case "lookup": {
      const user = locate(msg.postalCode);
      const item = await api.getItem(msg.itemId);
      resolved.set(msg.itemId, item.id);
      if (msg.mode === "delivery") {
        return { ok: true, item: { ...item, delivery: await api.getDelivery(item.id, msg.postalCode) }, stores: [], complete: true };
      }
```

(keep the rest of the body, which still calls `locate` for the store stock), and:

```js
    case "findInStock": {
      // Shoppers ships from distribution centres: there is no farther store to try.
      if (msg.mode === "delivery") return { ok: true, inStock: [], searched: 0, checkedIds: [], complete: true, rateLimited: false };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run`
Expected: PASS, whole suite.

- [ ] **Step 5: Commit**

```bash
git add src/retailers/bestbuy/content.js src/retailers/staples/content.js src/retailers/shoppers/content.js test/bestbuy-api.test.js
git commit -m "feat: bestbuy, staples and shoppers answer delivery mode with the item's delivery summary"
```

---

### Task 5: The job carries the mode

**Files:**
- Modify: `src/lib/job.js`
- Test: `test/job.test.js`

**Interfaces:**
- Consumes: the content-script responses from Tasks 3 and 4, including their `complete` flag on a delivery lookup.
- Produces: `start({ retailer, itemId, postalCode, mode, input })`; every forwarded message carries `mode`; a delivery job ends at `done` with `job.search` set from the lookup's `complete`.

- [ ] **Step 1: Write the failing test**

Append to `test/job.test.js`:

```js
describe("delivery mode jobs", () => {
  it("forwards the mode, skips the search phase and records whether the answer can be widened", async () => {
    const storage = fakeStorage();
    const forward = vi.fn(async () => ({ ok: true, item: { ...item, delivery: { status: "available", quantity: 5, eta: "arrives Sep 22" } }, stores: [], complete: true }));
    const jobs = createJobs({ forward, storage });
    await jobs.start({ retailer: "staples", itemId: "1", postalCode: "M5V 3L9", mode: "delivery" });
    await flush(); await flush();
    const job = await jobs.get();
    expect(forward).toHaveBeenCalledTimes(1);
    expect(forward.mock.calls[0][0]).toMatchObject({ type: "lookup", mode: "delivery" });
    expect(job.mode).toBe("delivery");
    expect(job.phase).toBe("done");
    expect(job.search).toEqual({ searched: 0, remaining: 0, complete: true, rateLimited: false, noLocation: false });
    expect(job.item.delivery.status).toBe("available");
  });

  it("offers a widening search when the lookup says it is not complete, and runs it with the mode", async () => {
    const storage = fakeStorage();
    const forward = vi.fn(async (msg) => msg.type === "lookup"
      ? { ok: true, item, stores: [store("a", "out_of_stock", 1)], complete: false }
      : { ok: true, inStock: [store("b", "available", 9)], searched: 50, checkedIds: ["a", "b"], complete: true });
    const jobs = createJobs({ forward, storage });
    await jobs.start({ retailer: "walmart", itemId: "1", postalCode: "M5V 3L9", mode: "delivery" });
    await flush(); await flush();
    expect((await jobs.get()).search).toMatchObject({ searched: 1, complete: false });
    await jobs.continueSearch();
    await flush(); await flush();
    const job = await jobs.get();
    expect(forward.mock.calls[1][0]).toMatchObject({ type: "findInStock", mode: "delivery" });
    expect(job.inStock.map((s) => s.id)).toEqual(["b"]);
    expect(job.search.complete).toBe(true);
  });

  it("defaults to pickup and leaves that path unchanged", async () => {
    const storage = fakeStorage();
    const forward = vi.fn(async (msg) => msg.type === "lookup"
      ? { ok: true, item, stores: [store("a", "out_of_stock", 1)] }
      : { ok: true, inStock: [], searched: 3, checkedIds: ["a"], complete: true });
    const jobs = createJobs({ forward, storage });
    const started = await jobs.start({ retailer: "staples", itemId: "1", postalCode: "M5V 3L9" });
    expect(started.mode).toBe("pickup");
    await flush(); await flush();
    expect(forward.mock.calls.map((c) => c[0].mode)).toEqual(["pickup", "pickup"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/job.test.js`
Expected: FAIL — `job.mode` is undefined and the delivery job still runs the search phase.

- [ ] **Step 3: Write the implementation**

In `src/lib/job.js`, update the header comment's job shape line to include `mode`, then:

`search(job)` — add the mode to the forwarded message:

```js
      res = await forward({
        type: "findInStock", retailer: job.retailer, itemId: job.itemId, postalCode: job.postalCode, mode: job.mode,
        nearby: job.nearby, checkedIds: job.checkedIds, itemUrl: job.item?.url,
      });
```

`run(job)` — add the mode to the lookup, and end a delivery job after it:

```js
      res = await forward({ type: "lookup", retailer: job.retailer, itemId: job.itemId, postalCode: job.postalCode, mode: job.mode });
```

and replace the `shouldSearch` block with:

```js
    if (job.mode === "delivery") {
      // Delivery is answered by the lookup itself. `complete: false` means the adapter can
      // widen its answer (walmart's node count), which is what "Keep searching" then does.
      job.search = { searched: job.nearby.length, remaining: 0, complete: res.complete !== false, rateLimited: false, noLocation: false };
      job.phase = "done";
      return save(job);
    }
    if (!shouldSearch(job.item, job.nearby)) {
      job.phase = "done";
      return save(job);
    }
```

`start(...)` — accept and store the mode, defaulting to pickup:

```js
  async function start({ retailer, itemId, postalCode, mode = "pickup", input = "" }) {
    const job = {
      id: `${now()}-${Math.random().toString(36).slice(2, 8)}`, retailer, itemId, postalCode, mode, input,
      phase: "lookup", item: null, nearby: [], inStock: [], checkedIds: [], search: null, error: null, startedAt: now(), updatedAt: now(),
    };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run`
Expected: PASS, whole suite.

- [ ] **Step 5: Commit**

```bash
git add src/lib/job.js test/job.test.js
git commit -m "feat: jobs carry the fulfillment mode and delivery jobs finish at the lookup"
```

---

### Task 6: Background passes the mode through

**Files:**
- Modify: `src/background.js` (`handle`, the `startJob` case)
- Test: `test/background.test.js`

**Interfaces:**
- Consumes: `jobs.start({ retailer, itemId, postalCode, mode, input })` (Task 5).
- Produces: nothing new; `startJob` simply forwards `msg.mode`.

- [ ] **Step 1: Write the failing test**

Append inside the existing `describe("background handle", ...)` in `test/background.test.js`:

```js
  it("passes the mode from startJob to the job runner", async () => {
    const { chrome } = fakeChrome({ tabs: [{ id: 1, url: "https://www.staples.ca/" }] });
    const start = vi.fn(async (args) => ({ id: "j", ...args }));
    const res = await handle({ type: "startJob", retailer: "staples", itemId: "1", postalCode: "M5V 3L9", mode: "delivery", input: "u" }, { chrome, jobs: { start } });
    expect(start).toHaveBeenCalledWith({ retailer: "staples", itemId: "1", postalCode: "M5V 3L9", mode: "delivery", input: "u" });
    expect(res.job.mode).toBe("delivery");
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/background.test.js`
Expected: FAIL — `start` is called without `mode`.

- [ ] **Step 3: Write the implementation**

In `src/background.js`, in the `startJob` case:

```js
    case "startJob":
      return { ok: true, job: await jobs.start({ retailer: msg.retailer, itemId: msg.itemId, postalCode: msg.postalCode, mode: msg.mode, input: msg.input }) };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run`
Expected: PASS, whole suite.

- [ ] **Step 5: Commit**

```bash
git add src/background.js test/background.test.js
git commit -m "feat: startJob carries the fulfillment mode"
```

---

### Task 7: Popup wording for delivery mode

**Files:**
- Modify: `src/lib/delivery.js`
- Test: `test/delivery.test.js`

**Interfaces:**
- Produces: `deliveryModeStatus(item, postalCode) -> string` — the status line shown in delivery mode when there is no node list, empty when the item can be delivered.

- [ ] **Step 1: Write the failing test**

Append to `test/delivery.test.js`:

```js
describe("deliveryModeStatus", () => {
  const item = { name: "Thing", delivery: { status: "available", quantity: 5, eta: null } };
  it("says nothing when the item can be delivered", () => {
    expect(deliveryModeStatus(item, "M5V 3L9")).toBe("");
  });
  it("says so plainly when it cannot be delivered", () => {
    expect(deliveryModeStatus({ ...item, delivery: { status: "out_of_stock", quantity: 0, eta: null } }, "M5V 3L9"))
      .toBe("This item cannot be delivered to M5V 3L9.");
  });
  it("says the retailer did not answer when the status is unknown or missing", () => {
    expect(deliveryModeStatus({ ...item, delivery: { status: "unknown", quantity: null, eta: null } }, "M5V 3L9"))
      .toBe("This store did not say whether it delivers to M5V 3L9.");
    expect(deliveryModeStatus({ ...item, delivery: null }, "M5V 3L9"))
      .toBe("This store did not say whether it delivers to M5V 3L9.");
  });
  it("says nothing without an item", () => {
    expect(deliveryModeStatus(null, "M5V 3L9")).toBe("");
  });
});
```

Add `deliveryModeStatus` to the import at the top of that file.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/delivery.test.js`
Expected: FAIL with `deliveryModeStatus is not a function`.

- [ ] **Step 3: Write the implementation**

Append to `src/lib/delivery.js`:

```js
// The status line for delivery mode when the retailer returns no per-store list: it has to
// carry the bad news on its own, because there is nothing else on screen to read.
export function deliveryModeStatus(item, postalCode) {
  if (!item) return "";
  const where = postalCode || "you";
  if (item.delivery?.status === "available") return "";
  if (item.delivery?.status === "out_of_stock") return `This item cannot be delivered to ${where}.`;
  return `This store did not say whether it delivers to ${where}.`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/delivery.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/delivery.js test/delivery.test.js
git commit -m "feat: delivery-mode status wording"
```

---

### Task 8: The popup's mode radio and delivery rendering

**Files:**
- Modify: `src/popup/popup.html`, `src/popup/popup.css`, `src/popup/popup.js`
- Test: manual, through `tools/e2e-popup.mjs` in Task 9

**Interfaces:**
- Consumes: `deliveryModeStatus(item, postalCode)` (Task 7), `job.mode` (Task 5).
- Produces: the popup sends `{ type: "startJob", ..., mode }` and renders a delivery job.

- [ ] **Step 1: Add the radio to the markup**

In `src/popup/popup.html`, between the postal-code label and the submit button:

```html
    <fieldset class="modes">
      <legend>Fulfillment</legend>
      <label><input type="radio" name="mode" value="pickup" checked> Pickup</label>
      <label><input type="radio" name="mode" value="delivery"> Delivery</label>
    </fieldset>
```

and change the submit button's text to a neutral one, since it now serves both modes:

```html
    <button id="submit" type="submit">Find stock</button>
```

- [ ] **Step 2: Style it**

Append to `src/popup/popup.css`:

```css
.modes { display: flex; gap: 14px; align-items: center; margin: 0; padding: 0; border: 0; }
.modes legend { float: left; width: 100%; font-weight: 600; padding: 0; }
.modes label { display: flex; gap: 4px; align-items: center; font-weight: 400; }
.modes input { width: auto; margin: 0; }
```

- [ ] **Step 3: Read, remember and send the mode**

In `src/popup/popup.js`, import the new helper:

```js
import { deliveryText, deliveryModeStatus } from "../lib/delivery.js";
```

Add two helpers next to `$`:

```js
const selectedMode = () => document.querySelector('input[name="mode"]:checked')?.value ?? "pickup";
const setMode = (mode) => { const el = document.querySelector(`input[name="mode"][value="${mode}"]`); if (el) el.checked = true; };
```

In the submit handler, read it, remember it and send it:

```js
  const mode = selectedMode();
  chrome.storage.local.set({ postalCode, mode });
  showError("");
  send({ type: "startJob", retailer: parsed.retailer, itemId: parsed.itemId, postalCode, mode, input: input.trim() });
```

and in the startup block that restores the postal code:

```js
chrome.storage.local.get(["postalCode", "mode"]).then(({ postalCode, mode }) => {
  if (postalCode && !$("postal").value) $("postal").value = postalCode;
  if (mode) setMode(mode);
});
```

- [ ] **Step 4: Render a delivery job**

Still in `src/popup/popup.js`, in `render(j)`, after `job = j;` add:

```js
  if (j?.mode) setMode(j.mode); // a job started by another popup wins over the remembered choice
  const delivery = j?.mode === "delivery";
```

Replace the nearby-list and nearest-box lines in `render` with mode-aware ones.
Delivery mode shows no "Nearby stores" list at all, and its list of locations
comes from `j.inStock` — the job seeds that from the lookup's nodes and merges
the widened ones into it, so reading `j.nearby` here would drop them:

```js
  $("stores").replaceChildren(...(delivery ? [] : j.nearby.map(storeRow)));
  $("nearbyHeading").hidden = delivery || !j.nearby.length;
  const showNearest = delivery
    // also when the list is empty but can still be widened: "Keep searching farther" lives in this box
    ? j.inStock.length > 0 || j.search?.complete === false
    : Boolean(j.item) && (j.search != null || j.phase === "interrupted" || (j.phase === "error" && j.nearby.length > 0));
  $("nearest").hidden = !showNearest;
  $("nearestHeading").textContent = delivery ? "Delivers from" : "Nearest in stock";
  $("nearestStores").replaceChildren(...j.inStock.slice(0, NEAREST_SHOWN).map(storeRow));
```

In `statusText(j)`, handle delivery mode before the pickup wording. It carries
the whole answer when nothing can be delivered, since the list is then empty:

```js
function statusText(j) {
  const label = RETAILERS[j.retailer]?.label ?? "pickup";
  if (j.phase === "lookup") return "Looking up…";
  if (j.phase === "searching") return j.search ? `Searching farther stores… ${j.search.searched} checked, ${j.search.remaining} to go` : "Searching farther stores…";
  if (j.mode === "delivery") return deliveryModeStatus(j.item, j.postalCode);
  if (j.item && !j.nearby.length) {
    if (j.item.pickupEligible === false) return "This item is not offered for store pickup."; // the item notice stays visible: it is the reason
    if (!j.search) return `No ${label} pickup store found near that postal code.`;
  }
  return "";
}
```

In `nearestNote(j)`, return delivery wording before the pickup branches:

```js
  if (j.mode === "delivery") {
    if (!s || s.complete) return { text: "", more: false };
    return {
      text: j.inStock.length
        ? "Showing the delivery locations nearest you. There may be more."
        : "No delivery location near you has it. Keep searching to check more.",
      more: true,
    };
  }
```

(put this right after `const s = j.search;` and before the `j.phase === "interrupted"` line).

In `storeRow(s)`, the pickup button must not appear in delivery mode:

```js
  if (job?.retailer === "walmart" && job?.mode !== "delivery") {
```

Give the nearest heading an id in `src/popup/popup.html` so the text can change:

```html
    <h2 id="nearestHeading">Nearest in stock</h2>
```

- [ ] **Step 5: Build and eyeball it**

Run: `npm run build`
Expected: `built dist/` with no errors.

- [ ] **Step 6: Commit**

```bash
git add src/popup/popup.html src/popup/popup.css src/popup/popup.js
git commit -m "feat: popup mode radio and delivery-mode rendering"
```

---

### Task 9: End-to-end check across the four retailers

**Files:**
- Modify: `tools/e2e-popup.mjs`
- Modify: `README.md`, `docs/walmart-ca-endpoints.md`

**Interfaces:**
- Consumes: everything above.
- Produces: `node tools/e2e-popup.mjs "<url>|<postal>|<mode>"`, mode optional and defaulting to `pickup`.

- [ ] **Step 1: Teach the e2e tool about the mode**

In `tools/e2e-popup.mjs`, parse a third field and set the radio before submitting:

```js
const scenarios = process.argv.slice(2).map((s) => { const [url, postal, mode = "pickup"] = s.split("|"); return { url, postal, mode }; });
```

```js
  for (const { url, postal, mode } of scenarios) {
    console.log(`\n=== ${url} @ ${postal} [${mode}]`);
    await evalIn(`(() => { const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); };
      set("item", ${JSON.stringify(url)}); set("postal", ${JSON.stringify(postal)});
      document.querySelector('input[name="mode"][value=' + ${JSON.stringify(JSON.stringify(mode))} + ']').checked = true;
      document.getElementById("form").requestSubmit(); return "submitted"; })()`);
```

and add the heading to the snapshot so the run shows which list is on screen:

```js
    heading: document.getElementById("nearestHeading").textContent,
```

- [ ] **Step 2: Run it against the four retailers**

Run:

```sh
npm run build
node tools/e2e-popup.mjs \
  "https://www.staples.ca/products/3082604-en-brother-hl-l2405w-home-office-ready-monochrome-laser-printer|M5V 3L9|delivery" \
  "https://www.bestbuy.ca/en-ca/product/19446111|M5V 3L9|delivery" \
  "https://www.shoppersdrugmart.ca/webber-magnesium-bisglycinate-200-mg/p/BB_625273036947?variantCode=625273036947|M5V 3L9|delivery"
```

Expected: each scenario ends with a `delivery` line filled in, `nearby: []`, `nearest: []` and no error. Wait two minutes, then run the walmart pair on its own so the two calls stay clear of the rate limit:

```sh
node tools/e2e-popup.mjs "6000208927194|M5V 3L9|pickup"
# wait ~2 minutes
node tools/e2e-popup.mjs "6000208927194|M5V 3L9|delivery"
```

Expected: the pickup run shows "Nearest in stock" with pickup stores; the delivery run shows "Delivers from" with a different set of stores. Record the two store lists in the commit message — that difference is the whole point of the feature.

- [ ] **Step 3: Document it**

In `README.md`, under the delivery section added on 2026-09-15, replace its first sentence with:

```markdown
The popup asks for a fulfillment type before it searches. **Pickup** lists the
nearest stores that have the item and then searches the country for the nearest
one in stock. **Delivery** asks whether the item ships to the postal code you
typed, and for Walmart also lists the delivery locations that have it, because
walmart.ca answers pickup and delivery separately: the same item can be in stock
for pickup at one store and only for delivery at another.
```

In `docs/walmart-ca-endpoints.md`, replace the "Delivery (ship-to-home): not wired up" section with:

```markdown
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
```

- [ ] **Step 4: Run the whole suite and build once more**

Run: `npx vitest run && npm run build`
Expected: all tests pass, `built dist/`.

- [ ] **Step 5: Commit**

```bash
git add tools/e2e-popup.mjs README.md docs/walmart-ca-endpoints.md
git commit -m "docs: delivery mode in the readme and walmart endpoints, plus an e2e mode flag"
```

---

## Done

Merge the branch into `master` with `--no-ff`, run `npx vitest run` on master, and push only when the user asks.
