// Dev-only. Builds src/retailers/walmart/stores-ca.json (every walmart.ca pickup node with
// coordinates) by walking nearByNodes outward from seed cities. Needs a Chrome
// started with --remote-debugging-port=9222 that has a walmart.ca tab open.
//   node tools/build-store-list.mjs
// One call every 25 s (walmart allows ~25 calls per ~10 min); on HTTP 429 it sleeps 10 min and retries the same probe.
// Progress is checkpointed in the OS temp dir so a crashed run resumes where it stopped.
import { writeFileSync, mkdirSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "retailers", "walmart", "stores-ca.json");
const STATE = join(tmpdir(), "walmart-store-list-state.json");
const HASH = "d26e41479a06dc27775a042b88b74ea8b5b75d3a670bcafd080eb7a4e2bdf66f";
const RADIUS_KM = 100, MAX_COUNT = 50, CALL_GAP_MS = 25000, BACKOFF_MS = 10 * 60 * 1000;
const SEEDS = [
  [43.65, -79.38], [45.50, -73.57], [49.28, -123.12], [51.04, -114.07], [53.55, -113.49], [45.42, -75.70],
  [49.90, -97.14], [46.81, -71.21], [44.65, -63.58], [52.13, -106.67], [50.45, -104.62], [42.98, -81.25],
  [46.49, -80.99], [48.38, -89.25], [47.56, -52.71], [46.09, -64.78], [49.89, -119.50], [53.92, -122.75],
  [48.43, -123.37], [60.72, -135.06], [62.45, -114.37], [56.73, -111.38], [55.17, -118.80], [56.25, -120.85],
  [54.52, -128.60], [48.48, -81.33], [48.10, -77.80], [50.21, -66.38], [49.22, -68.15], [48.95, -57.95],
  [55.74, -97.86], [54.77, -101.88], [49.77, -94.49], [49.78, -92.84], [46.52, -84.33], [48.24, -79.02],
  [46.24, -63.13], [46.14, -60.19], [47.62, -65.65], [48.95, -54.61], [52.94, -66.91], [50.02, -110.68],
  [49.70, -112.83], [52.27, -113.81], [50.68, -120.34], [49.50, -117.29], [50.72, -113.97], [45.28, -66.06],
  [47.00, -65.47], [49.13, -68.20], [48.42, -71.06], [46.35, -72.55], [45.40, -71.89], [45.64, -73.50],
  [44.38, -79.69], [45.35, -79.20], [46.32, -79.46], [44.23, -76.48], [44.10, -77.58], [43.55, -80.25],
  [42.31, -83.04], [42.40, -82.19], [44.56, -80.94], [43.90, -78.86], [46.02, -73.44], [49.03, -122.80],
  [50.25, -119.27], [53.20, -105.75], [50.39, -105.53], [53.99, -97.85],
];

let msgId = 0; const waiters = new Map(); let ws;
const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const id = ++msgId; waiters.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toRad = (d) => (d * Math.PI) / 180;
function haversineKm(a, b) {
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

function buildUrl(lat, lon) {
  const variables = {
    input: { postalCode: null, accessTypes: ["PICKUP_INSTORE", "PICKUP_CURBSIDE"], nodeTypes: ["STORE", "PICKUP_SPOKE", "PICKUP_POPUP"],
      latitude: lat, longitude: lon, radius: RADIUS_KM, maxCount: MAX_COUNT },
    checkItemAvailability: false, checkWeeklyReservation: false, enableStoreSelectorMarketplacePickup: false,
    enableVisionStoreSelector: false, enableStorePagesAndFinderPhase2: false, enableStoreBrandFormat: false,
    disableNodeAddressPostalCode: false, enableWICStoreSelector: false, enableSparkStore: false,
  };
  return `https://www.walmart.ca/orchestra/graphql/nearByNodes/${HASH}?variables=${encodeURIComponent(JSON.stringify(variables))}`;
}
const HEADERS = { accept: "application/json", "content-type": "application/json", "x-o-platform": "rweb", "x-o-bu": "WALMART-CA",
  "x-o-mart": "B2C", "x-o-segment": "oaoh", "x-o-ccm": "server", wm_mp: "true", "x-apollo-operation-name": "nearByNodes", "x-o-gql-query": "query nearByNodes" };

async function probe(sessionId, lat, lon) {
  const expr = `fetch(${JSON.stringify(buildUrl(lat, lon))},{credentials:"include",headers:${JSON.stringify(HEADERS)}}).then(async r=>({status:r.status,text:await r.text()}))`;
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
  const { status, text } = r.result.value;
  if (status === 429) return { rateLimited: true };
  let json; try { json = JSON.parse(text); } catch { throw new Error(`HTTP ${status} non-JSON: ${text.slice(0, 200)}`); }
  const nodes = json?.data?.nearByNodes?.nodes;
  // A point with no pickup node in range answers SERVICE_UNAVAILABLE ("No access point ...").
  if (nodes == null && json?.errors?.some((e) => e?.message === "SERVICE_UNAVAILABLE")) return { nodes: [] };
  if (!Array.isArray(nodes)) throw new Error(`HTTP ${status}: ${text.slice(0, 300)}`);
  return { nodes };
}

const v = await (await fetch("http://127.0.0.1:9222/json/version")).json();
ws = new WebSocket(v.webSocketDebuggerUrl);
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); const w = waiters.get(m.id); if (!w) return; waiters.delete(m.id); m.error ? w.rej(new Error(m.error.message)) : w.res(m.result); };
await new Promise((r) => (ws.onopen = r));
const { targetInfos } = await send("Target.getTargets");
const tab = targetInfos.find((t) => t.type === "page" && /walmart\.ca/.test(t.url));
if (!tab) throw new Error("no walmart.ca tab in the debug Chrome");
const { sessionId } = await send("Target.attachToTarget", { targetId: tab.targetId, flatten: true });

const stores = new Map();
let centres = SEEDS.map(([lat, lon]) => ({ lat, lon }));
let queue = [...centres];
let calls = 0;
// Keep whatever is already in the output (e.g. from build-store-list-pages.mjs) and resume a checkpointed run.
if (existsSync(OUT)) for (const s of JSON.parse(readFileSync(OUT, "utf8")).stores) stores.set(s.id, s);
if (existsSync(STATE)) {
  const st = JSON.parse(readFileSync(STATE, "utf8"));
  for (const s of st.stores) if (!stores.has(s.id)) stores.set(s.id, s);
  centres = st.centres; queue = st.queue; calls = st.calls;
  console.log(`resuming: ${stores.size} stores, ${queue.length} probes queued`);
}
const save = () => {
  const list = [...stores.values()].sort((a, b) => a.id.localeCompare(b.id));
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), stores: list }));
  writeFileSync(STATE, JSON.stringify({ stores: list, centres, queue, calls }));
};
while (queue.length) {
  const c = queue.shift();
  let res;
  for (;;) {
    res = await probe(sessionId, c.lat, c.lon);
    calls++;
    if (!res.rateLimited) break;
    console.log(`${new Date().toISOString()} 429 after ${calls} calls; sleeping ${BACKOFF_MS / 60000} min`);
    await sleep(BACKOFF_MS);
  }
  let maxDist = 0, added = 0;
  for (const n of res.nodes) {
    const d = Number.parseFloat(n.distance); if (Number.isFinite(d)) maxDist = Math.max(maxDist, d);
    const g = n.geoPoint; if (!g || typeof g.latitude !== "number") continue;
    if (!stores.has(n.id)) added++;
    stores.set(String(n.id), { id: String(n.id), name: String(n.displayName ?? n.name ?? ""), type: n.type, lat: g.latitude, lon: g.longitude });
  }
  // Stores near the edge of what this probe saw become new probe centres, unless something already probes near them.
  const threshold = res.nodes.length >= MAX_COUNT ? Math.min(60, 0.7 * maxDist) : 60;
  for (const n of res.nodes) {
    const g = n.geoPoint; if (!g) continue;
    const p = { lat: g.latitude, lon: g.longitude };
    if (Number.parseFloat(n.distance) < threshold) continue;
    if (centres.some((k) => haversineKm(k, p) < threshold)) continue;
    centres.push(p); queue.push(p);
  }
  console.log(`${new Date().toISOString()} call ${calls} @${c.lat.toFixed(2)},${c.lon.toFixed(2)} nodes=${res.nodes.length} max=${maxDist.toFixed(0)}km new=${added} total=${stores.size} queue=${queue.length}`);
  save();
  await sleep(CALL_GAP_MS);
}
save();
unlinkSync(STATE);
console.log(`done: ${stores.size} stores, ${calls} calls -> ${OUT}`);
process.exit(0);
