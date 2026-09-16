import { describe, it, expect, vi } from "vitest";
import { createJobs, shouldSearch, mergeInStock, JOB_KEY } from "../src/lib/job.js";

const flush = () => new Promise((r) => setTimeout(r, 0));
const fakeStorage = () => {
  const data = {};
  return { data, get: vi.fn(async (k) => ({ [k]: data[k] })), set: vi.fn(async (o) => Object.assign(data, o)) };
};
const item = { id: "1", name: "Thing", url: "https://www.staples.ca/products/1", retailer: "staples", pickupEligible: true };
const store = (id, status, km) => ({ id, name: id, address: "", postalCode: "", distanceKm: km, status, url: null });

describe("shouldSearch", () => {
  it("searches when any nearby store has a known status", () => {
    expect(shouldSearch(item, [store("a", "out_of_stock", 1)])).toBe(true);
    expect(shouldSearch(item, [store("a", "unknown", 1)])).toBe(false);
  });
  it("searches from an empty nearby list unless the item is not pickup-eligible", () => {
    expect(shouldSearch(item, [])).toBe(true);
    expect(shouldSearch({ ...item, pickupEligible: false }, [])).toBe(false);
  });
});

describe("mergeInStock", () => {
  it("dedupes by id and sorts by distance, unknown last", () => {
    const out = mergeInStock([store("a", "available", 5), store("b", "available", null)], [store("a", "available", 4), store("c", "available", 1)]);
    expect(out.map((s) => s.id)).toEqual(["c", "a", "b"]);
    expect(out[1].distanceKm).toBe(4);
  });
});

describe("jobs", () => {
  it("runs lookup then search in the background and persists every phase", async () => {
    const storage = fakeStorage();
    const phases = [];
    storage.set.mockImplementation(async (o) => { Object.assign(storage.data, o); phases.push(o[JOB_KEY].phase); });
    const forward = vi.fn(async (msg) => msg.type === "lookup"
      ? { ok: true, item, stores: [store("a", "out_of_stock", 1)] }
      : { ok: true, inStock: [store("z", "available", 40)], searched: 12, checkedIds: ["a", "z"], complete: true, rateLimited: false });
    const jobs = createJobs({ forward, storage, now: () => 1000 });
    const started = await jobs.start({ retailer: "staples", itemId: "1", postalCode: "M5V 3L9", input: "https://www.staples.ca/products/1" });
    expect(started.phase).toBe("lookup");
    await flush(); await flush();
    const job = await jobs.get();
    expect(job.phase).toBe("done");
    expect(job.item).toEqual(item);
    expect(job.nearby).toHaveLength(1);
    expect(job.inStock.map((s) => s.id)).toEqual(["z"]);
    expect(job.checkedIds).toEqual(["a", "z"]);
    expect(job.search).toMatchObject({ searched: 12, complete: true });
    expect(phases).toEqual(["lookup", "searching", "done"]);
    expect(forward.mock.calls[1][0]).toMatchObject({ type: "findInStock", nearby: [expect.objectContaining({ id: "a" })], checkedIds: [], itemUrl: item.url, postalCode: "M5V 3L9" });
  });

  it("stops after lookup when nothing nearby has a known status", async () => {
    const storage = fakeStorage();
    const forward = vi.fn(async () => ({ ok: true, item, stores: [store("a", "unknown", 1)] }));
    const jobs = createJobs({ forward, storage });
    await jobs.start({ retailer: "staples", itemId: "1", postalCode: "M5V 3L9" });
    await flush();
    expect((await jobs.get()).phase).toBe("done");
    expect(forward).toHaveBeenCalledTimes(1);
  });

  it("records a lookup failure as an error job", async () => {
    const storage = fakeStorage();
    const jobs = createJobs({ forward: vi.fn(async () => ({ ok: false, code: "not_found", error: "Item not found." })), storage });
    await jobs.start({ retailer: "staples", itemId: "1", postalCode: "M5V 3L9" });
    await flush();
    expect(await jobs.get()).toMatchObject({ phase: "error", error: { code: "not_found", message: "Item not found." }, item: null });
  });

  it("keeps a done job with no nearby stores when the search reports noLocation", async () => {
    const storage = fakeStorage();
    const forward = vi.fn(async (msg) => msg.type === "lookup" ? { ok: true, item, stores: [] } : { ok: true, inStock: [], searched: 0, checkedIds: [], complete: false, noLocation: true });
    const jobs = createJobs({ forward, storage });
    await jobs.start({ retailer: "staples", itemId: "1", postalCode: "P0T 2L0" });
    await flush(); await flush();
    expect(await jobs.get()).toMatchObject({ phase: "done", search: null, nearby: [] });
  });

  it("updates progress while searching and ignores it otherwise", async () => {
    const storage = fakeStorage();
    let release;
    const forward = vi.fn(async (msg) => msg.type === "lookup" ? { ok: true, item, stores: [store("a", "out_of_stock", 1)] } : new Promise((r) => (release = r)));
    const jobs = createJobs({ forward, storage });
    await jobs.start({ retailer: "staples", itemId: "1", postalCode: "M5V 3L9" });
    await flush(); await flush();
    expect((await jobs.get()).phase).toBe("searching");
    await jobs.progress({ calls: 3, searched: 15, remaining: 280 });
    expect((await jobs.get()).search).toMatchObject({ searched: 15, remaining: 280, complete: false });
    release({ ok: true, inStock: [], searched: 300, checkedIds: ["a"], complete: true });
    await flush(); await flush();
    expect((await jobs.get()).phase).toBe("done");
    await jobs.progress({ searched: 999, remaining: 0 });
    expect((await jobs.get()).search.searched).toBe(300);
  });

  it("continueSearch resumes from checkedIds and merges results", async () => {
    const storage = fakeStorage();
    const forward = vi.fn(async (msg) => msg.type === "lookup"
      ? { ok: true, item, stores: [store("a", "out_of_stock", 1)] }
      : forward.mock.calls.filter((c) => c[0].type === "findInStock").length === 1
        ? { ok: true, inStock: [store("y", "available", 90)], searched: 40, checkedIds: ["a", "y"], complete: false }
        : { ok: true, inStock: [store("x", "available", 60)], searched: 80, checkedIds: ["a", "y", "x"], complete: true });
    const jobs = createJobs({ forward, storage });
    await jobs.start({ retailer: "staples", itemId: "1", postalCode: "M5V 3L9" });
    await flush(); await flush();
    expect((await jobs.get()).search.complete).toBe(false);
    await jobs.continueSearch();
    await flush(); await flush();
    const job = await jobs.get();
    expect(job.inStock.map((s) => s.id)).toEqual(["x", "y"]);
    expect(job.search.complete).toBe(true);
    expect(forward.mock.calls.at(-1)[0].checkedIds).toEqual(["a", "y"]);
  });

  it("a newer job supersedes an older one whose answer arrives late", async () => {
    const storage = fakeStorage();
    let releaseOld;
    const forward = vi.fn(async (msg) => msg.itemId === "old" ? new Promise((r) => (releaseOld = r)) : { ok: true, item, stores: [store("a", "unknown", 1)] });
    const jobs = createJobs({ forward, storage });
    await jobs.start({ retailer: "staples", itemId: "old", postalCode: "M5V 3L9" });
    const fresh = await jobs.start({ retailer: "staples", itemId: "1", postalCode: "M5V 3L9" });
    await flush();
    releaseOld({ ok: true, item: { ...item, name: "OLD" }, stores: [] });
    await flush(); await flush();
    const job = await jobs.get();
    expect(job.id).toBe(fresh.id);
    expect(job.item.name).toBe("Thing");
  });

  it("recover marks a mid-flight job as interrupted (or error before the item is known)", async () => {
    const storage = fakeStorage();
    storage.data[JOB_KEY] = { id: "j", phase: "searching", item, nearby: [], inStock: [], checkedIds: ["a"] };
    const jobs = createJobs({ forward: vi.fn(), storage });
    expect((await jobs.recover()).phase).toBe("interrupted");
    storage.data[JOB_KEY] = { id: "k", phase: "lookup", item: null };
    const jobs2 = createJobs({ forward: vi.fn(), storage });
    expect(await jobs2.recover()).toMatchObject({ phase: "error", error: { code: "unknown" } });
  });

  it("get reads the stored job when the worker has just started", async () => {
    const storage = fakeStorage();
    storage.data[JOB_KEY] = { id: "j", phase: "done", item };
    const jobs = createJobs({ forward: vi.fn(), storage });
    expect((await jobs.get()).id).toBe("j");
  });
});

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

  it("updates job.item.delivery when the widening search reports a fresher delivery summary", async () => {
    const storage = fakeStorage();
    const forward = vi.fn(async (msg) => msg.type === "lookup"
      ? { ok: true, item: { ...item, delivery: { status: "out_of_stock", quantity: null, eta: null } }, stores: [store("a", "out_of_stock", 1)], complete: false }
      : { ok: true, inStock: [store("b", "available", 9)], searched: 50, checkedIds: ["a", "b"], complete: true, delivery: { status: "available", quantity: null, eta: null } });
    const jobs = createJobs({ forward, storage });
    await jobs.start({ retailer: "walmart", itemId: "1", postalCode: "M5V 3L9", mode: "delivery" });
    await flush(); await flush();
    expect((await jobs.get()).item.delivery).toEqual({ status: "out_of_stock", quantity: null, eta: null });
    await jobs.continueSearch();
    await flush(); await flush();
    const job = await jobs.get();
    expect(job.item.delivery).toEqual({ status: "available", quantity: null, eta: null });
  });

  it("leaves job.item untouched when a pickup search's findInStock carries no delivery field", async () => {
    const storage = fakeStorage();
    const forward = vi.fn(async (msg) => msg.type === "lookup"
      ? { ok: true, item, stores: [store("a", "out_of_stock", 1)] }
      : { ok: true, inStock: [store("z", "available", 40)], searched: 12, checkedIds: ["a", "z"], complete: true, rateLimited: false });
    const jobs = createJobs({ forward, storage });
    await jobs.start({ retailer: "staples", itemId: "1", postalCode: "M5V 3L9" });
    await flush(); await flush();
    const job = await jobs.get();
    expect(job.phase).toBe("done");
    expect(job.item).toEqual(item); // no `delivery` field appears anywhere on it
  });
});
