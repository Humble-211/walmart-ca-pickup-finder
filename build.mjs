import { build } from "esbuild";
import { cpSync, mkdirSync, readdirSync, rmSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist/popup", { recursive: true });
mkdirSync("dist/options", { recursive: true });

const retailers = readdirSync("src/retailers", { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

await build({
  entryPoints: {
    ...Object.fromEntries(retailers.map((r) => [`content/${r}`, `src/retailers/${r}/content.js`])),
    "background": "src/background.js",
    "popup/popup": "src/popup/popup.js",
    "options/options": "src/options/options.js",
  },
  bundle: true,
  format: "iife",
  target: "chrome120",
  outdir: "dist",
  sourcemap: false,
  logLevel: "info",
});

cpSync("src/manifest.json", "dist/manifest.json");
cpSync("src/popup/popup.html", "dist/popup/popup.html");
cpSync("src/popup/popup.css", "dist/popup/popup.css");
cpSync("src/options/options.html", "dist/options/options.html");
cpSync("src/options/options.css", "dist/options/options.css");
console.log("built dist/");
