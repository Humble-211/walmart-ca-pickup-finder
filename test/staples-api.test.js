import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { getItem, getAvailability, getDelivery, buildProductUrl, buildAvailabilityBody, buildDeliveryBody, AVAILABILITY_URL } from "../src/retailers/staples/api.js";

const fx = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8");
const jsonResponse = (body, status = 200) => new Response(body, { status, headers: { "content-type": "application/json" } });
const HANDLE = "3082604-en-brother-hl-l2405w-home-office-ready-monochrome-laser-printer";

describe("staples request builders", () => {
  it("buildProductUrl targets the Shopify product .js for the full handle", () => {
    expect(buildProductUrl(HANDLE)).toBe(`https://www.staples.ca/products/${HANDLE}.js`);
  });
  it("buildAvailabilityBody sends the documented PickInStore body", () => {
    expect(buildAvailabilityBody("3082604", "M5V 3L9")).toEqual({
      locale: "en-CA", postal_code: "M5V 3L9", items: [{ sku: "3082604", quantity: 1000 }], location: "PickInStore",
    });
    expect(AVAILABILITY_URL).toBe("https://api.staples.ca/ecommerce/inventory/v2.0/request");
  });
});

describe("staples delivery", () => {
  it("buildDeliveryBody sends the ship-to-home body", () => {
    expect(buildDeliveryBody("3082604", "M5V 3L9")).toEqual({ locale: "en-CA", postal_code: "M5V 3L9", items: [{ sku: "3082604", quantity: 1, is_dropship: true }], location: "M5V 3L9" });
  });
  it("getDelivery POSTs the ship-to-home body and parses the row", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(fx("staples-delivery.json")));
    vi.stubGlobal("fetch", fetchMock);
    try {
      expect(await getDelivery("3082604", "M5V 3L9")).toEqual({ status: "available", quantity: 30, eta: "arrives Sep 22" });
      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual(buildDeliveryBody("3082604", "M5V 3L9"));
    } finally { vi.unstubAllGlobals(); }
  });
});

describe("staples fetching", () => {
  let fetchMock;
  beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock); });
  afterEach(() => vi.unstubAllGlobals());

  it("getItem fetches with credentials omitted and parses the product", async () => {
    fetchMock.mockResolvedValue(jsonResponse(fx("staples-product.json")));
    const item = await getItem(HANDLE);
    expect(item.retailer).toBe("staples");
    expect(item.id).toBe(HANDLE);
    expect(fetchMock.mock.calls[0][1].credentials).toBe("omit");
  });
  it("getItem maps a 404 to not_found", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 404 }));
    await expect(getItem("99999999-en-nope")).rejects.toMatchObject({ code: "not_found" });
  });
  it("getItem maps an HTML-bodied 404 to not_found, not verification", async () => {
    fetchMock.mockResolvedValue(new Response("<!DOCTYPE html><html><body>Not Found</body></html>", { status: 404, headers: { "content-type": "text/html" } }));
    await expect(getItem("99999999-en-nope")).rejects.toMatchObject({ code: "not_found" });
  });
  it("getAvailability POSTs JSON with credentials omitted and parses the stores", async () => {
    fetchMock.mockResolvedValue(jsonResponse(fx("staples-availability.json")));
    const stores = await getAvailability("3082604", "M5V 3L9");
    expect(stores.length).toBeGreaterThan(0);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(AVAILABILITY_URL);
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("omit");
    expect(init.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual(buildAvailabilityBody("3082604", "M5V 3L9"));
  });
  it("maps 400 postal-code validation to invalid_postal, 429 to rate_limited, HTML/403 to verification", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse('{"title":"One or more validation errors occurred.","status":400,"errors":{"PostalCode":["must match"]}}', 400));
    await expect(getAvailability("1", "M5V")).rejects.toMatchObject({ code: "invalid_postal" });
    fetchMock.mockResolvedValueOnce(new Response("", { status: 429 }));
    await expect(getAvailability("1", "M5V 3L9")).rejects.toMatchObject({ code: "rate_limited" });
    fetchMock.mockResolvedValueOnce(new Response("<html>", { status: 403, headers: { "content-type": "text/html" } }));
    await expect(getItem(HANDLE)).rejects.toMatchObject({ code: "verification" });
  });
});
