import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import {
  buildHeaders, buildNearByNodesUrl, buildItemUrl, buildSetPickupBody,
  getItem, findStores, findStoresAround, selectStore,
} from "../src/retailers/walmart/api.js";

const nearBy = readFileSync(new URL("./fixtures/nearByNodes.json", import.meta.url), "utf8");
const item = readFileSync(new URL("./fixtures/itemById.json", import.meta.url), "utf8");

const jsonResponse = (body, status = 200) =>
  new Response(body, { status, headers: { "content-type": "application/json" } });

describe("request builders", () => {
  it("buildHeaders includes the required headers", () => {
    const h = buildHeaders("nearByNodes");
    expect(h["x-o-bu"]).toBe("WALMART-CA");
    expect(h["x-o-mart"]).toBe("B2C");
    expect(h["x-o-segment"]).toBe("oaoh");
    expect(h["x-apollo-operation-name"]).toBe("nearByNodes");
    expect(h["content-type"]).toBe("application/json");
  });

  it("buildNearByNodesUrl encodes the documented variables", () => {
    const url = new URL(buildNearByNodesUrl("M1P 4P5", "6000208927194", 10));
    expect(url.origin + url.pathname).toBe(
      "https://www.walmart.ca/orchestra/graphql/nearByNodes/d26e41479a06dc27775a042b88b74ea8b5b75d3a670bcafd080eb7a4e2bdf66f");
    const v = JSON.parse(url.searchParams.get("variables"));
    expect(v.input).toEqual({
      postalCode: "M1P 4P5",
      accessTypes: ["PICKUP_INSTORE", "PICKUP_CURBSIDE"],
      nodeTypes: ["STORE", "PICKUP_SPOKE", "PICKUP_POPUP"],
      latitude: null, longitude: null, radius: null,
      productId: "6000208927194",
      maxCount: 10,
    });
    expect(v.checkItemAvailability).toBe(true);
    for (const k of ["checkWeeklyReservation", "enableStoreSelectorMarketplacePickup", "enableVisionStoreSelector",
      "enableStorePagesAndFinderPhase2", "enableStoreBrandFormat", "disableNodeAddressPostalCode",
      "enableWICStoreSelector", "enableSparkStore"]) {
      expect(v[k]).toBe(false);
    }
  });

  it("buildNearByNodesUrl with a point sends lat/lon/radius and no postal code", () => {
    const url = new URL(buildNearByNodesUrl(null, "1SZQHN3LOSE0", 50, { lat: 43.64, lon: -79.39, radiusKm: 100 }));
    const v = JSON.parse(url.searchParams.get("variables"));
    expect(v.input).toMatchObject({ postalCode: null, latitude: 43.64, longitude: -79.39, radius: 100, productId: "1SZQHN3LOSE0", maxCount: 50 });
    expect(v.checkItemAvailability).toBe(true);
  });

  it("buildItemUrl targets the ItemById hash and sets iId", () => {
    const url = new URL(buildItemUrl("6000208927194"));
    expect(url.pathname).toBe(
      "/orchestra/pdp/graphql/ItemById/dd90c309e2b4c9418dc5050720b5f8c8520e593aaf942fd2c7f6321ea820d500/ip/6000208927194");
    const v = JSON.parse(url.searchParams.get("variables"));
    expect(v.iId).toBe("6000208927194");
    expect(v.tenant).toBe("CA_GLASS");
    expect(v.fRev).toBe(false);
    expect(Object.keys(v)).toHaveLength(38);
  });

  it("buildSetPickupBody uses numeric storeId and the store accessPointId", () => {
    const body = buildSetPickupBody({ id: "3635", accessPointId: "86de1e9c-5357-4500-83d1-f0535de6c4c2" }, "M1P 4P5");
    expect(body).toEqual({
      variables: { input: {
        accessPointId: "86de1e9c-5357-4500-83d1-f0535de6c4c2",
        cartId: "00000000-0000-0000-0000-000000000000",
        postalCode: "M1P 4P5",
        storeId: 3635,
        enableLiquorBox: false,
        enableCartSplitClarity: true,
        features: ["lmpdel"],
      } },
    });
  });
});

describe("fetching", () => {
  let fetchMock;
  beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("findStores GETs with credentials and parses stores", async () => {
    fetchMock.mockResolvedValue(jsonResponse(nearBy));
    const stores = await findStores("M1P 4P5", "6000208927194");
    expect(stores).toHaveLength(5);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/orchestra/graphql/nearByNodes/");
    expect(init.credentials).toBe("include");
    expect(init.method ?? "GET").toBe("GET");
    expect(init.headers["x-apollo-operation-name"]).toBe("nearByNodes");
  });

  it("findStoresAround queries by point for the 50 nearest stores within 100 km", async () => {
    fetchMock.mockResolvedValue(jsonResponse(nearBy));
    const stores = await findStoresAround(45.5, -73.6, "1SZQHN3LOSE0");
    expect(stores).toHaveLength(5);
    const v = JSON.parse(new URL(fetchMock.mock.calls[0][0]).searchParams.get("variables"));
    expect(v.input).toMatchObject({ postalCode: null, latitude: 45.5, longitude: -73.6, radius: 100, maxCount: 50 });
  });

  it("maps HTTP 429 to rate_limited", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 429 }));
    await expect(findStores("M1P 4P5", "1")).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("getItem parses the item", async () => {
    fetchMock.mockResolvedValue(jsonResponse(item));
    const parsed = await getItem("6000208927194");
    expect(parsed.name).toMatch(/^Bounty/);
    expect(fetchMock.mock.calls[0][1].headers["x-apollo-operation-name"]).toBe("ItemById");
  });

  it("selectStore POSTs the body and returns the store id from the response", async () => {
    fetchMock.mockResolvedValue(jsonResponse(JSON.stringify({
      data: { fulfillmentMutations: { setPickup: { fulfillment: { pickupStore: { storeId: "3635" } } } } },
    })));
    const out = await selectStore({ id: "3635", accessPointId: "abc" }, "M1P 4P5");
    expect(out).toEqual({ storeId: "3635" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/orchestra/graphql/setPickup/");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body).variables.input.storeId).toBe(3635);
  });

  it("selectStore throws api_changed when the response has no pickupStore", async () => {
    fetchMock.mockResolvedValue(jsonResponse(JSON.stringify({ data: { fulfillmentMutations: { setPickup: null } }, errors: [{ message: "Missing required header x-o-segment" }] })));
    await expect(selectStore({ id: "3635", accessPointId: "abc" }, "M1P 4P5")).rejects.toMatchObject({ code: "api_changed" });
  });

  it("maps HTTP 403 to verification", async () => {
    fetchMock.mockResolvedValue(new Response("<html>press and hold</html>", { status: 403, headers: { "content-type": "text/html" } }));
    await expect(findStores("M1P 4P5", "1")).rejects.toMatchObject({ code: "verification" });
  });

  it("maps HTTP 412 to verification", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 412 }));
    await expect(findStores("M1P 4P5", "1")).rejects.toMatchObject({ code: "verification" });
  });

  it("maps an HTML 200 body to verification", async () => {
    fetchMock.mockResolvedValue(new Response("<html>challenge</html>", { status: 200, headers: { "content-type": "text/html" } }));
    await expect(getItem("1")).rejects.toMatchObject({ code: "verification" });
  });

  it("maps HTTP 400 JSON to api_changed with the raw body", async () => {
    fetchMock.mockResolvedValue(jsonResponse('{"code":400,"message":"Something went wrong while processing the query."}', 400));
    await expect(findStores("M1P 4P5", "1")).rejects.toMatchObject({
      code: "api_changed",
      message: 'Walmart changed its API: {"code":400,"message":"Something went wrong while processing the query."}',
    });
  });

  it("propagates invalid_postal from the parser", async () => {
    fetchMock.mockResolvedValue(jsonResponse(JSON.stringify({ data: { nearByNodes: null }, errors: [{ message: "INVALID_POSTAL_CODE" }] })));
    await expect(findStores("ZZZ 999", "1")).rejects.toMatchObject({ code: "invalid_postal" });
  });
});
