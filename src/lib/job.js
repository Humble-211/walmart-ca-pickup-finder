// The background worker owns one lookup-and-search "job" at a time and persists every
// step to extension storage, so the popup (which Chrome destroys the moment it loses
// focus) is only a view: it renders whatever job state is stored and re-renders on change.
//
// Job shape:
//   { id, retailer, itemId, postalCode, mode, input, phase, item, nearby, inStock, checkedIds,
//     search: { searched, remaining, complete, rateLimited, noLocation } | null,
//     error: { code, message } | null, startedAt, updatedAt }
// phase: "lookup" -> ("searching" ->)* "done" | "error" | "interrupted"
export const JOB_KEY = "job";

// Worth searching beyond the nearby list when the retailer reports pickup availability for
// this item at all, or when no store at all is within its nearby radius (a remote postal
// code): adapters that can place the user without nearby stores search outward, the others
// answer noLocation.
export function shouldSearch(item, nearby) {
  const known = nearby.some((s) => s.status !== "unknown");
  return known || (!nearby.length && item?.pickupEligible !== false);
}

export function mergeInStock(current, found) {
  const byId = new Map(current.map((s) => [s.id, s]));
  for (const s of found) byId.set(s.id, s);
  return [...byId.values()].sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity));
}

// deps: forward(msg) -> content-script response for lookup/findInStock (retailer named in msg);
//       storage: chrome.storage area (get/set); now(): ms clock.
export function createJobs({ forward, storage, now = Date.now }) {
  let current = null;

  async function save(job) {
    job.updatedAt = now();
    current = job;
    await storage.set({ [JOB_KEY]: job });
    return job;
  }

  async function get() {
    if (current) return current;
    const stored = await storage.get(JOB_KEY);
    current = stored?.[JOB_KEY] ?? null;
    return current;
  }

  const isCurrent = (job) => current?.id === job.id;

  async function fail(job, res, fallback) {
    if (!isCurrent(job)) return;
    job.phase = "error";
    job.error = { code: res?.code ?? "unknown", message: res?.error ?? fallback };
    await save(job);
  }

  // `exhaustive` tells the adapter to cover the rest of its catalogue instead of
  // stopping once nothing unchecked could be closer. The automatic first search stays
  // fast; only "Keep searching farther" asks for the full sweep.
  async function search(job, exhaustive = false) {
    job.phase = "searching";
    job.error = null;
    await save(job);
    let res;
    try {
      res = await forward({
        type: "findInStock", retailer: job.retailer, itemId: job.itemId, postalCode: job.postalCode, mode: job.mode,
        nearby: job.nearby, checkedIds: job.checkedIds, itemUrl: job.item?.url, item: job.item, exhaustive,
      });
    } catch (err) {
      return fail(job, null, String(err?.message ?? err));
    }
    if (!isCurrent(job)) return; // superseded by a newer job while the content script was working
    if (!res?.ok) return fail(job, res, "Search failed.");
    if (res.noLocation && !job.nearby.length) {
      job.phase = "done"; // nothing nearby to locate the user from: the "no store near that postal code" state stands
      return save(job);
    }
    job.inStock = mergeInStock(job.inStock, res.inStock ?? []);
    job.checkedIds = res.checkedIds ?? job.checkedIds;
    if (res.delivery) job.item = { ...job.item, delivery: res.delivery };
    job.search = { searched: res.searched ?? 0, remaining: 0, complete: Boolean(res.complete), rateLimited: Boolean(res.rateLimited), noLocation: Boolean(res.noLocation), exhaustive: Boolean(res.exhaustive) };
    job.phase = "done";
    return save(job);
  }

  async function run(job) {
    let res;
    try {
      res = await forward({ type: "lookup", retailer: job.retailer, itemId: job.itemId, postalCode: job.postalCode, mode: job.mode });
    } catch (err) {
      return fail(job, null, String(err?.message ?? err));
    }
    if (!isCurrent(job)) return;
    if (!res?.ok) return fail(job, res, "Lookup failed.");
    job.item = res.item;
    job.nearby = res.stores ?? [];
    job.inStock = job.nearby.filter((s) => s.status === "available");
    job.checkedIds = [];
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
    return search(job);
  }

  // Starts a new job (replacing any running one) and returns it right away; the work continues in the background.
  async function start({ retailer, itemId, postalCode, mode = "pickup", input = "" }) {
    const job = {
      id: `${now()}-${Math.random().toString(36).slice(2, 8)}`, retailer, itemId, postalCode, mode, input,
      phase: "lookup", item: null, nearby: [], inStock: [], checkedIds: [], search: null, error: null, startedAt: now(), updatedAt: now(),
    };
    await save(job);
    run(job).catch((err) => fail(job, null, String(err?.message ?? err)));
    return structuredClone(job); // a snapshot: the live object keeps changing as the work proceeds
  }

  // "Keep searching farther": resumes the nationwide search from checkedIds.
  async function continueSearch() {
    const job = await get();
    if (!job || !job.item || job.phase === "lookup" || job.phase === "searching") return job;
    search(job, true).catch((err) => fail(job, null, String(err?.message ?? err)));
    return job;
  }

  // searchProgress from the content script: { calls, searched, remaining }.
  async function progress(msg) {
    const job = await get();
    if (!job || job.phase !== "searching") return;
    job.search = { ...(job.search ?? {}), searched: msg.searched ?? job.search?.searched ?? 0, remaining: msg.remaining ?? 0, complete: false, rateLimited: false, noLocation: false };
    await save(job);
  }

  // Called when the worker starts: a job left mid-flight by a worker that was shut down cannot finish.
  async function recover() {
    const job = await get();
    if (job && (job.phase === "lookup" || job.phase === "searching")) {
      job.phase = job.item ? "interrupted" : "error";
      if (!job.item) job.error = { code: "unknown", message: "The lookup was interrupted. Try again." };
      await save(job);
    }
    return job;
  }

  return { start, continueSearch, get, progress, recover };
}
