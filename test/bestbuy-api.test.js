import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { getItem, getStores, getAvailability, buildAvailabilityUrl, buildStoresUrl, buildProductUrl, LOCATIONS_PER_CALL } from "../src/retailers/bestbuy/api.js";

const fx = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8");
const jsonResponse = (body, status = 200) => new Response(body, { status, headers: { "content-type": "application/json" } });

describe("bestbuy request builders", () => {
  it("buildAvailabilityUrl sends the standardproduct accept parameter, pipe-joined locations and the sku", () => {
    const url = new URL(buildAvailabilityUrl("19446111", ["927", "196"]));
    expect(url.origin + url.pathname).toBe("https://www.bestbuy.ca/ecomm-api/availability/products");
    expect(url.searchParams.get("accept")).toBe("application/vnd.bestbuy.standardproduct.v1+json");
    expect(url.searchParams.get("accept-language")).toBe("en-CA");
    expect(url.searchParams.get("locations")).toBe("927|196");
    expect(url.searchParams.get("skus")).toBe("19446111");
    expect(url.searchParams.has("postalCode")).toBe(false);
  });
  it("buildStoresUrl asks for everything in range in one page", () => {
    const url = new URL(buildStoresUrl("M5V 3L9"));
    expect(url.pathname).toBe("/api/v3/json/locations");
    expect(url.searchParams.get("postalCode")).toBe("M5V 3L9");
    expect(url.searchParams.get("pageSize")).toBe("1000");
    expect(url.searchParams.get("lang")).toBe("en-CA");
  });
  it("buildProductUrl queries the catalog by id", () => {
    const url = new URL(buildProductUrl("19446111"));
    expect(url.pathname).toBe("/api/v1/catalog/query");
    expect(url.searchParams.get("ids")).toBe("19446111");
    expect(url.searchParams.get("lang")).toBe("en-CA");
  });
  it("LOCATIONS_PER_CALL stays under the measured 96 ceiling", () => {
    expect(LOCATIONS_PER_CALL).toBeLessThanOrEqual(96);
  });
});

describe("bestbuy fetching", () => {
  let fetchMock;
  beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock); });
  afterEach(() => vi.unstubAllGlobals());

  it("getAvailability parses statuses", async () => {
    fetchMock.mockResolvedValue(jsonResponse(fx("bestbuy-availability.json")));
    const { statuses } = await getAvailability("19446111", ["927"]);
    expect(statuses.size).toBeGreaterThan(0);
  });
  it("getAvailability refuses more ids than one call accepts", async () => {
    await expect(getAvailability("1", Array.from({ length: LOCATIONS_PER_CALL + 1 }, (_, i) => String(i)))).rejects.toThrow(/locations/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("getItem parses the product", async () => {
    fetchMock.mockResolvedValue(jsonResponse(fx("bestbuy-product.json")));
    expect((await getItem("19446111")).retailer).toBe("bestbuy");
  });
  it("getStores parses the locator", async () => {
    fetchMock.mockResolvedValue(jsonResponse(fx("bestbuy-stores.json")));
    expect((await getStores("M5V 3L9")).length).toBeGreaterThan(0);
  });
  it("maps HTML/403 to verification, 429 to rate_limited, other non-2xx JSON to api_changed", async () => {
    fetchMock.mockResolvedValueOnce(new Response("<html>", { status: 403, headers: { "content-type": "text/html" } }));
    await expect(getItem("1")).rejects.toMatchObject({ code: "verification" });
    fetchMock.mockResolvedValueOnce(new Response("", { status: 429 }));
    await expect(getItem("1")).rejects.toMatchObject({ code: "rate_limited" });
    fetchMock.mockResolvedValueOnce(jsonResponse('{"errorCode":"1103","errorMessage":"Invalid query parameter"}', 400));
    await expect(getItem("1")).rejects.toMatchObject({ code: "api_changed" });
  });
});

describe("availability postal code", () => {
  it("adds postalCode to the availability url only when given", () => {
    expect(buildAvailabilityUrl("19446111", ["927", "196"], "M5V 3L9")).toContain("postalCode=M5V+3L9");
    expect(buildAvailabilityUrl("19446111", ["927", "196"])).not.toContain("postalCode");
  });
  it("getAvailability returns the delivery summary next to the statuses", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(readFileSync(new URL("./fixtures/bestbuy-availability.json", import.meta.url), "utf8"), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const res = await getAvailability("19446111", ["927"], "M5V 3L9");
      expect(res.delivery).toEqual({ status: "available", quantity: 1394, eta: "by Sep 16" });
      expect(res.statuses.size).toBeGreaterThan(0);
      expect(fetchMock.mock.calls[0][0]).toContain("postalCode=M5V+3L9");
    } finally { vi.unstubAllGlobals(); }
  });
});

describe("delivery without stores", () => {
  it("builds a valid call with no locations and still parses the shipping answer", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(readFileSync(new URL("./fixtures/bestbuy-availability.json", import.meta.url), "utf8"), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const { delivery } = await getAvailability("19446111", [], "M5V 3L9");
      expect(delivery.status).toBe("available");
      expect(fetchMock.mock.calls[0][0]).toContain("locations=&");
      expect(fetchMock.mock.calls[0][0]).toContain("postalCode=M5V+3L9");
    } finally { vi.unstubAllGlobals(); }
  });
});
