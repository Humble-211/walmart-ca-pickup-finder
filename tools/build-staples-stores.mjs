// Dev-only. Builds src/retailers/staples/stores-ca.json from Staples' public Algolia
// store_locations index (302 stores in one call). docs/staples-ca-endpoints.md §4
//   node tools/build-staples-stores.mjs
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "retailers", "staples", "stores-ca.json");
const ENDPOINT = "https://H5YOVYKINU-dsn.algolia.net/1/indexes/store_locations/query";
const HEADERS = { "content-type": "application/json", "x-algolia-application-id": "H5YOVYKINU", "x-algolia-api-key": "4689de77d9aedbf48bf24a6da6cbebdd" };
const POSTAL = /([A-Za-z]\d[A-Za-z]\s?\d[A-Za-z]\d)\s*$/;

const res = await fetch(ENDPOINT, { method: "POST", headers: HEADERS, body: JSON.stringify({ params: "query=&hitsPerPage=1000" }) });
if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
const { hits, nbHits } = await res.json();
if (nbHits > hits.length) throw new Error(`Algolia reports ${nbHits} hits but only ${hits.length} came back in one page; add pagination.`);
const stores = [];
for (const h of hits) {
  const lat = Number(h.lat ?? h._geoloc?.lat), lon = Number(h.lng ?? h._geoloc?.lng);
  const postal = (String(h.store_address ?? "").match(POSTAL) ?? [])[1];
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !postal || h.store_number == null) { console.log("skipped", JSON.stringify(h).slice(0, 120)); continue; }
  // "<street> / <city>, <prov> <postal>" — keep any extra " / " segments (unseen in the 302
  // Canadian stores as of 2026-09-15, but the theme's own data does not guarantee exactly one).
  const [street = "", ...rest] = String(h.store_address).split(" / ");
  const cityProv = rest.join(" / ");
  stores.push({ id: String(h.store_number), name: `Staples ${h.store ?? ""}`.trim(), address: `${street.trim()}, ${cityProv.trim()}`, postalCode: postal.toUpperCase().replace(/^(\w{3})\s?(\w{3})$/, "$1 $2"), lat, lon });
}
stores.sort((a, b) => Number(a.id) - Number(b.id));
writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), source: "algolia:store_locations", tool: "tools/build-staples-stores.mjs", stores }) + "\n");
console.log(`done: ${stores.length} stores (${hits.length} hits) -> ${OUT}`);
