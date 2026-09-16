import { describe, it, expect, vi } from "vitest";
import { handle, makeJobs } from "../src/background.js";

function fakeChrome({ tabs = [], answers = {}, pingResults } = {}) {
  const created = [];
  const pingCalls = new Map();
  const chrome = {
    tabs: {
      query: vi.fn(async ({ url }) => tabs.filter((t) => new RegExp("^" + url.replace(/[.]/g, "\\.").replace("*", ".*")).test(t.url))),
      sendMessage: vi.fn(async (tabId, msg) => {
        if (msg.type === "ping") {
          if (pingResults) {
            const n = pingCalls.get(tabId) ?? 0;
            pingCalls.set(tabId, n + 1);
            const results = pingResults[tabId] ?? [];
            return results[n] ?? results[results.length - 1] ?? { ok: true };
          }
          return { ok: true };
        }
        return answers[tabId] ?? { ok: true, echo: msg };
      }),
      reload: vi.fn(async () => {}),
      create: vi.fn(async ({ url }) => { const t = { id: 100 + created.length, url }; created.push(t); tabs.push(t); return t; }),
    },
  };
  return { chrome, created };
}

describe("background handle", () => {
  it("forwards a lookup to a tab on the retailer's host", async () => {
    const { chrome } = fakeChrome({ tabs: [{ id: 1, url: "https://www.walmart.ca/en" }, { id: 2, url: "https://www.bestbuy.ca/en-ca" }] });
    const res = await handle({ type: "lookup", retailer: "walmart", itemId: "1", postalCode: "M5V 3L9" }, { chrome });
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(1, expect.objectContaining({ type: "lookup" }));
    expect(res.echo.itemId).toBe("1");
  });
  it("opens the retailer's home page when no tab exists", async () => {
    const { chrome, created } = fakeChrome();
    await handle({ type: "lookup", retailer: "walmart", itemId: "1", postalCode: "M5V 3L9" }, { chrome, sleepMs: 0 });
    expect(created[0].url).toBe("https://www.walmart.ca/en");
  });
  it("rejects an unknown retailer", async () => {
    const { chrome } = fakeChrome();
    expect(await handle({ type: "lookup", retailer: "sears" }, { chrome })).toMatchObject({ ok: false, code: "unsupported" });
  });
  it("refuses to open a product URL on another host after selectStore", async () => {
    const { chrome } = fakeChrome({ tabs: [{ id: 1, url: "https://www.walmart.ca/en" }] });
    const res = await handle({ type: "selectStore", retailer: "walmart", store: {}, postalCode: "M5V 3L9", itemUrl: "https://evil.example/x" }, { chrome });
    expect(res.ok).toBe(false);
    expect(chrome.tabs.create).not.toHaveBeenCalled();
    // The refusal happens before forwarding, so the content script never runs setPickup.
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalledWith(1, expect.objectContaining({ type: "selectStore" }));
  });
  it("forwards a lookup with retailer: bestbuy to the bestbuy tab", async () => {
    const { chrome } = fakeChrome({ tabs: [{ id: 1, url: "https://www.walmart.ca/en" }, { id: 2, url: "https://www.bestbuy.ca/en-ca" }] });
    const res = await handle({ type: "lookup", retailer: "bestbuy", itemId: "19446111", postalCode: "M5V 3L9" }, { chrome });
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(2, expect.objectContaining({ type: "lookup" }));
    expect(res.echo.itemId).toBe("19446111");
  });
  it("re-sends a lookup when the content script vanished mid-answer (page reloaded), but never a selectStore", async () => {
    const { chrome } = fakeChrome({ tabs: [{ id: 1, url: "https://www.shoppersdrugmart.ca/" }] });
    const original = chrome.tabs.sendMessage.getMockImplementation();
    let failures = 2;
    chrome.tabs.sendMessage.mockImplementation(async (tabId, msg) => {
      if (msg.type !== "ping" && failures-- > 0) throw new Error("The message port closed before a response was received.");
      return original(tabId, msg);
    });
    const res = await handle({ type: "lookup", retailer: "shoppers", itemId: "625273036947", postalCode: "M5V 3L9" }, { chrome, sleepMs: 0 });
    expect(res.echo.itemId).toBe("625273036947");
    expect(chrome.tabs.sendMessage.mock.calls.filter((c) => c[1].type === "lookup")).toHaveLength(3);
    failures = 1;
    const sel = await handle({ type: "selectStore", retailer: "shoppers", store: {}, postalCode: "M5V 3L9", itemUrl: "https://www.shoppersdrugmart.ca/x/p/BB_1" }, { chrome, sleepMs: 0 });
    expect(sel).toMatchObject({ ok: false, code: "no_tab" });
    expect(chrome.tabs.sendMessage.mock.calls.filter((c) => c[1].type === "selectStore")).toHaveLength(1);
  });
  it("gives up with no_tab after three failed sends", async () => {
    const { chrome } = fakeChrome({ tabs: [{ id: 1, url: "https://www.walmart.ca/en" }] });
    const original = chrome.tabs.sendMessage.getMockImplementation();
    chrome.tabs.sendMessage.mockImplementation(async (tabId, msg) => { if (msg.type !== "ping") throw new Error("port closed"); return original(tabId, msg); });
    expect(await handle({ type: "lookup", retailer: "walmart", itemId: "1", postalCode: "M5V 3L9" }, { chrome, sleepMs: 0 })).toMatchObject({ ok: false, code: "no_tab" });
    expect(chrome.tabs.sendMessage.mock.calls.filter((c) => c[1].type === "lookup")).toHaveLength(3);
  });
  it("startJob runs the lookup and search through the retailer tab and stores the job", async () => {
    const { chrome } = fakeChrome({ tabs: [{ id: 1, url: "https://www.staples.ca/" }] });
    const item = { id: "1", name: "Thing", url: "https://www.staples.ca/products/1", retailer: "staples", pickupEligible: true };
    const answers = { lookup: { ok: true, item, stores: [{ id: "a", status: "out_of_stock", distanceKm: 1 }] }, findInStock: { ok: true, inStock: [{ id: "z", status: "available", distanceKm: 30 }], searched: 5, checkedIds: ["a", "z"], complete: true } };
    const original = chrome.tabs.sendMessage.getMockImplementation();
    chrome.tabs.sendMessage.mockImplementation(async (tabId, msg) => answers[msg.type] ?? original(tabId, msg));
    const data = {};
    chrome.storage = { session: { get: async (k) => ({ [k]: data[k] }), set: async (o) => Object.assign(data, o) } };
    const jobs = makeJobs(chrome, 0);
    const res = await handle({ type: "startJob", retailer: "staples", itemId: "1", postalCode: "M5V 3L9", input: "https://www.staples.ca/products/1" }, { chrome, jobs });
    expect(res.job.phase).toBe("lookup");
    await new Promise((r) => setTimeout(r, 10));
    const { job } = await handle({ type: "getJob" }, { chrome, jobs });
    expect(job).toMatchObject({ phase: "done", item, checkedIds: ["a", "z"] });
    expect(job.inStock.map((s) => s.id)).toEqual(["z"]);
    expect(data.job.phase).toBe("done");
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(1, expect.objectContaining({ type: "findInStock", itemUrl: item.url }));
  });
  it("startJob for an unknown retailer is refused", async () => {
    const { chrome } = fakeChrome();
    expect(await handle({ type: "startJob", retailer: "sears", itemId: "1", postalCode: "M5V 3L9" }, { chrome, jobs: makeJobs({ ...chrome, storage: { local: { get: async () => ({}), set: async () => {} } } }, 0) })).toMatchObject({ ok: false, code: "unsupported" });
  });
  it("getTab retries the ping after a reload and still finds the tab", async () => {
    const { chrome } = fakeChrome({
      tabs: [{ id: 1, url: "https://www.walmart.ca/en" }],
      pingResults: { 1: [{ ok: false }, { ok: true }] },
    });
    const res = await handle({ type: "lookup", retailer: "walmart", itemId: "1", postalCode: "M5V 3L9" }, { chrome, sleepMs: 0 });
    expect(chrome.tabs.reload).toHaveBeenCalledWith(1);
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(1, expect.objectContaining({ type: "lookup" }));
    expect(res.echo.itemId).toBe("1");
  });
});
