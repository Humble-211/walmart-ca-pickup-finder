// Dev-only. Builds src/lib/fsa-ca.json (forward sortation area -> centroid) from the
// GeoNames postal-code dump for Canada (CC BY 4.0, https://www.geonames.org/).
// Shoppers' store endpoint only takes coordinates, so a pasted postal code is
// located by its FSA (first three characters). docs/shoppers-ca-endpoints.md §0
//   node tools/build-fsa-list.mjs
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "lib", "fsa-ca.json");
const SOURCE = "https://download.geonames.org/export/zip/CA.zip";
const FSA = /^[A-Z]\d[A-Z]$/;

// Minimal zip reader: locate the entry through the central directory (the local
// headers in this archive carry zero sizes and rely on data descriptors).
function readZipEntry(buf, wanted) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error("not a zip file");
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = buf.readUInt16LE(eocd + 10); n > 0; n--) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("bad central directory");
    const method = buf.readUInt16LE(p + 10), compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    const local = buf.readUInt32LE(p + 42);
    if (name === wanted) {
      const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(dataStart, dataStart + compSize);
      if (method === 0) return data;
      if (method === 8) return inflateRawSync(data);
      throw new Error(`unsupported zip method ${method}`);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`${wanted} not in archive`);
}

const res = await fetch(SOURCE);
if (!res.ok) throw new Error(`HTTP ${res.status}`);
const text = readZipEntry(Buffer.from(await res.arrayBuffer()), "CA.txt").toString("utf8");
const fsa = {};
let skipped = 0;
for (const line of text.split("\n")) {
  const c = line.split("\t");
  if (c.length < 11) continue;
  const code = c[1].toUpperCase(), lat = Number(c[9]), lon = Number(c[10]);
  if (!FSA.test(code) || !Number.isFinite(lat) || !Number.isFinite(lon)) { skipped++; continue; }
  fsa[code] = [Number(lat.toFixed(4)), Number(lon.toFixed(4))];
}
const sorted = Object.fromEntries(Object.keys(fsa).sort().map((k) => [k, fsa[k]]));
writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), source: SOURCE, license: "CC BY 4.0 (GeoNames)", tool: "tools/build-fsa-list.mjs", fsa: sorted }) + "\n");
console.log(`done: ${Object.keys(sorted).length} FSAs (${skipped} rows skipped) -> ${OUT}`);
