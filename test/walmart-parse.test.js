import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseStores, parseItem } from "../src/retailers/walmart/parse.js";
import { WalmartApiError } from "../src/lib/errors.js";

const nearBy = JSON.parse(readFileSync(new URL("./fixtures/nearByNodes.json", import.meta.url), "utf8"));
const item = JSON.parse(readFileSync(new URL("./fixtures/itemById.json", import.meta.url), "utf8"));

describe("parseStores", () => {
  it("returns an empty list when walmart reports no pickup node near the point", () => {
    expect(parseStores({ data: { nearByNodes: null }, errors: [{ message: "SERVICE_UNAVAILABLE", extensions: { code: "400.204" } }] })).toEqual([]);
  });
  it("maps every node in the fixture", () => {
    const stores = parseStores(nearBy);
    expect(stores).toHaveLength(5);
    expect(stores.map((s) => s.id)).toEqual(["3635", "1117", "3111", "3159", "1080"]);
  });

  it("maps fields of the first store", () => {
    const s = parseStores(nearBy)[0];
    expect(s).toEqual({
      id: "3635",
      name: "Scarborough Central",
      address: "300 Borough Dr, Scarborough, ON M1P 4P5",
      postalCode: "M1P 4P5",
      distanceKm: 0.07,
      status: "available",
      accessPointId: "86de1e9c-5357-4500-83d1-f0535de6c4c2",
      url: null,
    });
  });

  it("maps OUT_OF_STOCK to out_of_stock", () => {
    expect(parseStores(nearBy)[1].status).toBe("out_of_stock");
  });

  it("maps a missing product block to unknown", () => {
    const copy = structuredClone(nearBy);
    delete copy.data.nearByNodes.nodes[0].product;
    expect(parseStores(copy)[0].status).toBe("unknown");
  });

  it("prefers active PICKUP_INSTORE, falls back to PICKUP_CURBSIDE, else null", () => {
    const copy = structuredClone(nearBy);
    const node = copy.data.nearByNodes.nodes[0];
    node.capabilities = node.capabilities.filter((c) => c.accessPointType !== "PICKUP_INSTORE");
    expect(parseStores(copy)[0].accessPointId).toBe("7f3bbbcf-2bd5-413c-81af-5391c5084b1a");
    node.capabilities = node.capabilities.map((c) => ({ ...c, isActive: false }));
    expect(parseStores(copy)[0].accessPointId).toBeNull();
  });

  it("uses null distance when distance is not numeric", () => {
    const copy = structuredClone(nearBy);
    copy.data.nearByNodes.nodes[0].distance = null;
    expect(parseStores(copy)[0].distanceKm).toBeNull();
  });

  it("throws invalid_postal on INVALID_POSTAL_CODE", () => {
    const body = { data: { nearByNodes: null }, errors: [{ message: "INVALID_POSTAL_CODE" }] };
    expect(() => parseStores(body)).toThrow(WalmartApiError);
    try { parseStores(body); } catch (e) { expect(e.code).toBe("invalid_postal"); }
  });

  it("throws api_changed when nodes are missing", () => {
    try { parseStores({ data: {} }); throw new Error("no throw"); } catch (e) {
      expect(e).toBeInstanceOf(WalmartApiError);
      expect(e.code).toBe("api_changed");
      expect(e.message).toMatch(/^Walmart changed its API: /);
    }
  });
});

describe("parseItem", () => {
  it("maps the fixture product", () => {
    expect(parseItem(item)).toEqual({
      id: "6000208927194",
      retailer: "walmart",
      name: "Bounty Paper Towel 8 Rolls (16 Regular Rolls Equivalent)",
      priceString: "$21.98",
      imageUrl: "https://i5.walmartimages.ca/asr/b7d197af-6dfa-4e8d-9b0d-299d1f914c4d.06c9ddf4c33575f5cb67360e68ce52fd.jpeg",
      url: "https://www.walmart.ca/en/ip/Bounty-Paper-Towel-8-Rolls-16-Regular-Rolls-Equivalent/6000208927194",
      pickupEligible: true,
    });
  });

  it("marks pickupEligible false when pickupOption.availabilityStatus is null", () => {
    const copy = structuredClone(item);
    copy.data.product.pickupOption.availabilityStatus = null;
    expect(parseItem(copy).pickupEligible).toBe(false);
  });

  it("falls back to /en/ip/<id> when canonicalUrl is missing and empty price when price is missing", () => {
    const copy = structuredClone(item);
    copy.data.product.canonicalUrl = null;
    copy.data.product.priceInfo = null;
    copy.data.product.imageInfo = null;
    const parsed = parseItem(copy);
    expect(parsed.url).toBe("https://www.walmart.ca/en/ip/6000208927194");
    expect(parsed.priceString).toBe("");
    expect(parsed.imageUrl).toBeNull();
  });

  it("throws not_found when product is null", () => {
    try { parseItem({ data: { product: null } }); throw new Error("no throw"); } catch (e) {
      expect(e.code).toBe("not_found");
    }
  });

  it("throws not_found when the product shell has empty name and usItemId", () => {
    const copy = structuredClone(item);
    copy.data.product.name = "";
    copy.data.product.usItemId = "";
    copy.data.product.id = null;
    copy.data.product.canonicalUrl = null;
    try { parseItem(copy); throw new Error("no throw"); } catch (e) {
      expect(e.code).toBe("not_found");
    }
  });

  it("throws api_changed when the shape is wrong", () => {
    try { parseItem({ foo: 1 }); throw new Error("no throw"); } catch (e) {
      expect(e.code).toBe("api_changed");
    }
  });

  it("throws api_changed when the product has usItemId but no name", () => {
    const json = { data: { product: { usItemId: "6000208927194", canonicalUrl: "/x" } } };
    try { parseItem(json); throw new Error("no throw"); } catch (e) {
      expect(e.code).toBe("api_changed");
    }
  });

  it("falls back to /en/ip/<id> when canonicalUrl is not a same-origin path", () => {
    const copy = structuredClone(item);
    copy.data.product.canonicalUrl = "@evil.com/x";
    expect(parseItem(copy).url).toBe("https://www.walmart.ca/en/ip/6000208927194");
  });

  it("falls back to /en/ip/<id> when canonicalUrl is protocol-relative", () => {
    const copy = structuredClone(item);
    copy.data.product.canonicalUrl = "//evil.com/x";
    expect(parseItem(copy).url).toBe("https://www.walmart.ca/en/ip/6000208927194");
  });
});
