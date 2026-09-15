// Dev-only. Completes src/lib/stores-ca.json by crawling walmart.ca store pages
// (/en/store/<id>), which carry the store's coordinates in JSON-LD and link to
// the 3 nearest stores. Page fetches are not subject to the nearByNodes rate
// limit, so this is the fast way to finish a list started by build-store-list.mjs
// (whose stores seed the crawl so remote regions are reached). Needs a Chrome
// started with --remote-debugging-port=9222 that has a walmart.ca tab open.
//   node tools/build-store-list-pages.mjs
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "lib", "stores-ca.json");
const GAP_MS = 700;
const SEED_IDS = ["3106", "1004", "3105", "1803"];

let msgId = 0; const waiters = new Map(); let ws;
const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const id = ++msgId; waiters.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchStorePage(sessionId, id) {
  const expr = String.raw`fetch(${JSON.stringify(`https://www.walmart.ca/en/store/${id}`)}).then(async r=>{const t=await r.text();
    const m=t.match(/"geo":\s*\{\s*"latitude":\s*([-\d.]+),\s*"longitude":\s*([-\d.]+)/);
    const name=(t.match(/"@type":\s*"Store"[\s\S]{0,400}?"name":\s*"([^"]+)"/)||t.match(/<title>([^|<]*)/)||[])[1]||"";
    const links=[...new Set((t.match(/\/en\/store\/(\d+)/g)||[]).map(s=>s.slice(10)))];
    return {status:r.status, lat:m?Number(m[1]):null, lon:m?Number(m[2]):null, name:name.trim(), links};})`;
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result.value;
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
if (existsSync(OUT)) for (const s of JSON.parse(readFileSync(OUT, "utf8")).stores) stores.set(s.id, s);
console.log(`starting from ${stores.size} known stores`);
const visited = new Set();
const queue = [...new Set([...SEED_IDS, ...stores.keys()])];
const save = () => {
  const list = [...stores.values()].sort((a, b) => a.id.localeCompare(b.id));
  writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), stores: list }));
};
let fetched = 0, failures = 0;
while (queue.length) {
  const id = queue.shift();
  if (visited.has(id)) continue;
  visited.add(id);
  let page;
  try { page = await fetchStorePage(sessionId, id); } catch (e) { failures++; console.log(`${id} error ${e.message}`); continue; }
  fetched++;
  if (page.status !== 200 || page.lat == null) { failures++; console.log(`${id} status=${page.status} geo=${page.lat}`); }
  else {
    const prev = stores.get(id);
    stores.set(id, { id, name: prev?.name || page.name, type: prev?.type ?? "STORE", lat: page.lat, lon: page.lon });
  }
  for (const l of page.links ?? []) if (!visited.has(l)) queue.push(l);
  if (fetched % 10 === 0) { save(); console.log(`${new Date().toISOString()} fetched=${fetched} stores=${stores.size} queue=${queue.length} failures=${failures}`); }
  await sleep(GAP_MS);
}
save();
console.log(`done: ${stores.size} stores after ${fetched} page fetches (${failures} failures) -> ${OUT}`);
process.exit(0);
