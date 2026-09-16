import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { getItem, getStoreStock, getDelivery, buildProductUrl, buildBaseProductUrl, buildDeliveryUrl, buildStoreDetailsBody, STORE_DETAILS_URL, API_KEY, RETRY } from "../src/retailers/shoppers/api.js";

const fx = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8");
const jsonResponse = (body, status = 200) => new Response(body, { status, headers: { "content-type": "application/json" } });
const CODE = "625273036947";
const CENTRE = { lat: 43.6416, lon: -79.387 };

describe("shoppers request builders", () => {
  it("targets the variant and base product endpoints", () => {
    expect(buildProductUrl(CODE)).toBe(`https://api.shoppersdrugmart.ca/beauty/v2/shoppersdrugmart/product/variantProduct/${CODE}/details`);
    expect(buildBaseProductUrl(CODE)).toBe(`https://api.shoppersdrugmart.ca/beauty/v2/shoppersdrugmart/product/baseProduct/BB_${CODE}/details`);
    expect(STORE_DETAILS_URL).toBe("https://api.shoppersdrugmart.ca/beauty/v2/shoppersdrugmart/store-locator/store-details?lang=en");
  });
  it("builds the fulfillment-options url with the postal code unspaced", () => {
    expect(buildDeliveryUrl(CODE, "M5V 3L9")).toBe(`https://api.shoppersdrugmart.ca/beauty/v2/shoppersdrugmart/product/${CODE}/fulfillment-options?storeId=&postalCode=M5V3L9`);
  });
  it("builds the documented store-details body", () => {
    expect(buildStoreDetailsBody(CODE, CENTRE)).toEqual({ latitude: 43.6416, longitude: -79.387, productId: CODE, inStock: false, storeType: 1 });
    expect(buildStoreDetailsBody(CODE, CENTRE, true).inStock).toBe(true);
  });
});

describe("shoppers fetching", () => {
  let fetchMock;
  beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock); });
  afterEach(() => vi.unstubAllGlobals());

  it("getItem sends the api key and cookies and parses the product", async () => {
    fetchMock.mockResolvedValue(jsonResponse(fx("shoppers-variant.json")));
    const item = await getItem(CODE);
    expect(item).toMatchObject({ id: CODE, retailer: "shoppers", name: "Webber Magnesium Bisglycinate 200 mg" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(buildProductUrl(CODE));
    expect(init.credentials).toBe("include");
    expect(init.headers["x-apikey"]).toBe(API_KEY);
    expect(init.headers.language).toBe("en");
  });
  it("getItem resolves a base-only code through the base product's first variant", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse('{"errors":[{"reason":"productNotFound"}]}', 404))
      .mockResolvedValueOnce(jsonResponse(fx("shoppers-base.json")))
      .mockResolvedValueOnce(jsonResponse(fx("shoppers-variant.json")));
    const item = await getItem("BASEONLY");
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([buildProductUrl("BASEONLY"), buildBaseProductUrl("BASEONLY"), buildProductUrl(CODE)]);
    expect(item.id).toBe(CODE);
  });
  it("getItem maps an unknown code to not_found (also when the base product is unknown)", async () => {
    fetchMock.mockImplementation(async () => jsonResponse('{"errors":[{"reason":"productNotFound"}]}', 404));
    await expect(getItem("000000000000")).rejects.toMatchObject({ code: "not_found" });
  });
  it("getStoreStock POSTs the body with cookies and parses the stores", async () => {
    fetchMock.mockResolvedValue(jsonResponse(fx("shoppers-store-details.json")));
    const stores = await getStoreStock(CODE, CENTRE, true);
    expect(stores).toHaveLength(10);
    expect(stores[0].id).toBe("1321");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(STORE_DETAILS_URL);
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("include");
    expect(init.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual(buildStoreDetailsBody(CODE, CENTRE, true));
  });
  it("getDelivery fetches the fulfillment options and parses the shipping block", async () => {
    fetchMock.mockResolvedValue(jsonResponse(fx("shoppers-delivery.json")));
    expect(await getDelivery(CODE, "M5V 3L9")).toEqual({ status: "available", quantity: 56, eta: "Estimated delivery in 1-3 business days" });
    expect(fetchMock.mock.calls[0][0]).toBe(buildDeliveryUrl(CODE, "M5V 3L9"));
  });
  it("getStoreStock returns [] on a 204", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    expect(await getStoreStock(CODE, CENTRE)).toEqual([]);
  });
  it("retries a network-level failure (Akamai 403 without CORS headers) and then reports verification with a {host} hint", async () => {
    RETRY.delayMs = 0;
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(getItem(CODE)).rejects.toMatchObject({ code: "verification", message: expect.stringContaining("{host}") });
    expect(fetchMock).toHaveBeenCalledTimes(RETRY.attempts + 1);
    fetchMock.mockReset();
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch")).mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValueOnce(jsonResponse(fx("shoppers-variant.json")));
    expect((await getItem(CODE)).id).toBe(CODE);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    fetchMock.mockReset();
    fetchMock.mockRejectedValueOnce(new RangeError("boom"));
    await expect(getItem(CODE)).rejects.toBeInstanceOf(RangeError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("maps 429 to rate_limited, 403/HTML to verification, 401 to api_changed", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 429 }));
    await expect(getStoreStock(CODE, CENTRE)).rejects.toMatchObject({ code: "rate_limited" });
    fetchMock.mockResolvedValueOnce(new Response("<HTML><HEAD><TITLE>Access Denied</TITLE>", { status: 403, headers: { "content-type": "text/html" } }));
    await expect(getItem(CODE)).rejects.toMatchObject({ code: "verification" });
    fetchMock.mockResolvedValueOnce(jsonResponse('{"error":"invalid_client"}', 401));
    await expect(getItem(CODE)).rejects.toMatchObject({ code: "api_changed" });
  });
});
