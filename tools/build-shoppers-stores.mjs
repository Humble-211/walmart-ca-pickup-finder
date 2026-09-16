// Dev-only. Builds src/retailers/shoppers/stores-ca.json from the store list behind
// shoppersdrugmart.ca's chat widget (Salesfloor), the only public endpoint that lists
// every store with coordinates in one call. docs/shoppers-ca-endpoints.md §4
//   node tools/build-shoppers-stores.mjs
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "retailers", "shoppers", "stores-ca.json");
const ENDPOINT = "https://api.services.shoppersdrugmart.ca/stores?filter%5Blocale%5D=en_US&per_page=5000";
const POSTAL = /^([A-Z]\d[A-Z])\s?(\d[A-Z]\d)$/;

const res = await fetch(ENDPOINT);
if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
const json = await res.json();
const rows = Array.isArray(json) ? json : Object.values(json);
if (rows.length < 1000) throw new Error(`only ${rows.length} rows came back; the endpoint used to return ~1190 stores`);
const title = (s) => s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
const stores = [];
for (const r of rows) {
  const lat = Number(r.latitude), lon = Number(r.longitude);
  // Two stores carry mistyped postal codes ("NBW 3T5"); keep them, the coordinates are what matter.
  const rawPostal = String(r.postal ?? "").toUpperCase().trim();
  const postal = rawPostal.match(POSTAL) ? rawPostal.replace(POSTAL, "$1 $2") : rawPostal;
  const id = String(r.retailer_store_id ?? "").padStart(4, "0");
  // "Queen's Quay  - Store 1321" -> "Queen's Quay"; closed stores read "<TOWN> (closed)".
  const short = String(r.name ?? "").replace(/\s*-\s*Store\s+\d+\s*$/i, "").trim();
  if (!/^\d{4}$/.test(id) || !Number.isFinite(lat) || !Number.isFinite(lon) || r.is_virtual !== "0" || r.shame_type !== "store" || /\(closed\)/i.test(short)) {
    console.log("skipped", JSON.stringify(r).slice(0, 120));
    continue;
  }
  stores.push({
    id,
    name: `Shoppers Drug Mart ${short}`,
    address: `${title(String(r.address ?? ""))}, ${title(String(r.city ?? ""))}, ${r.region} ${postal}`.trim(),
    postalCode: postal,
    lat, lon,
  });
}
stores.sort((a, b) => a.id.localeCompare(b.id));
writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), source: "salesfloor:api.services.shoppersdrugmart.ca/stores", tool: "tools/build-shoppers-stores.mjs", stores }) + "\n");
console.log(`done: ${stores.length} stores (${rows.length} rows) -> ${OUT}`);
