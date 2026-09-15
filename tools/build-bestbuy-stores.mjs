// Dev-only. Builds src/retailers/bestbuy/stores-ca.json by sweeping
// /api/v3/json/locations (fixed ~50 km radius around a postal code) over seed
// postal codes across Canada and de-duplicating on locationId.
//   node tools/build-bestbuy-stores.mjs
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildStoresUrl } from "../src/retailers/bestbuy/api.js";
import { parseStores } from "../src/retailers/bestbuy/parse.js";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "retailers", "bestbuy", "stores-ca.json");
const GAP_MS = 1000;
// One postal code per metro / region; the locator's radius is ~50 km so neighbouring seeds overlap.
const SEEDS = [
  "M5V 3L9", "L4T 9Z0", "L6Y 4R9", "L1H 7K5", "L3R 9W3", "L7L 6J8", "L8P 4S3", "L2R 7K6", "N2G 4X6", "N6A 3N7", "N9A 6K3", "N7T 7Y7",
  "L4M 1A1", "K7L 5C3", "K8N 3A5", "K1P 1J1", "K2C 3P4", "P3E 3K9", "P7B 5E1", "P4N 2K7", "P6A 1Y9", "P1B 2H3", "N1H 3A4", "N8X 1J3",
  "H2Y 1C6", "H4T 1E7", "J4K 5G4", "J7Y 4V2", "G1R 4P5", "G6V 8N6", "J1H 5H9", "G8Z 3G7", "J2S 2M2", "G7H 5B8", "G9A 5J3", "J8X 2A2", "J9X 5V7", "G4R 4K3",
  "V6B 1A1", "V3M 1A7", "V5H 4M1", "V2X 2P2", "V3T 2W2", "V9A 1A2", "V9R 5S5", "V1Y 6M6", "V2C 1X2", "V2A 5L6", "V1L 4E3", "V2L 3G1", "V8J 1P4", "V9N 2L4", "V1A 2A9",
  "T2P 1J9", "T3K 5P4", "T5J 0N3", "T6E 5V5", "T4N 3T7", "T1K 2R3", "T1Y 1H6", "T9H 1T6", "T8V 2Z9", "T1H 4A1", "T9E 6Z7", "T8N 4B5",
  "S7K 0J5", "S4P 3Y2", "S6H 4H3", "S9A 2H5", "S6V 5T2",
  "R3C 0V8", "R7A 0A1", "R8N 0Y5",
  "B3J 1S9", "B2Y 3Y8", "B4A 3Y7", "B1P 6J7", "B4N 3E8", "B2N 5B7",
  "E1C 1B4", "E2L 4L1", "E3B 5H1", "E2A 1V3", "E7M 2Z3", "C1A 1A1",
  "A1B 3X5", "A2H 6J8", "A1V 1W3", "A2A 2K3", "A2N 2X5",
  "Y1A 1A1", "X1A 2N1", "X0E 0T0",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stores = new Map();
for (const [i, seed] of SEEDS.entries()) {
  const res = await fetch(buildStoresUrl(seed));
  if (!res.ok) { console.log(`${seed}: HTTP ${res.status}`); continue; }
  const list = parseStores(await res.json());
  let added = 0, skipped = 0;
  for (const s of list) {
    if (!Number.isFinite(s.lat) || !Number.isFinite(s.lon)) { skipped++; continue; }
    if (!stores.has(s.id)) { stores.set(s.id, { id: s.id, name: s.name, address: s.address, postalCode: s.postalCode, lat: s.lat, lon: s.lon }); added++; }
  }
  console.log(`${i + 1}/${SEEDS.length} ${seed}: ${list.length} in range, ${added} new, ${skipped} skipped (no coordinates), ${stores.size} total`);
  await sleep(GAP_MS);
}
const list = [...stores.values()].sort((a, b) => a.id.localeCompare(b.id));
writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), stores: list }) + "\n");
console.log(`done: ${list.length} stores -> ${OUT}`);
