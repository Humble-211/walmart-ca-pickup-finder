// Dev-only end-to-end check: starts a throwaway Chrome, installs dist/ as an unpacked
// extension over the DevTools protocol, opens the popup and runs one lookup per
// "<product url>|<postal code>" argument, printing what the popup shows.
//   npm run build && node tools/e2e-popup.mjs "https://www.shoppersdrugmart.ca/x/p/BB_625273036947|M5V 3L9"
// With REOPEN=1 the popup is closed a few seconds after each submit and reopened, to check
// that the job carries on in the background and the reopened popup picks it up.
// Chrome 137+ ignores --load-extension, so the extension is installed with
// Extensions.loadUnpacked (needs --enable-unsafe-extension-debugging). Do NOT use
// --remote-debugging-pipe: it sets navigator.webdriver, which Akamai-fronted sites
// (shoppersdrugmart.ca) answer with 403 for every request.
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const CHROME = process.env.CHROME || join(process.env.LOCALAPPDATA ?? "", "Google", "Chrome", "Application", "chrome.exe");
const PORT = 9222;
const PROFILE = join(process.env.TEMP ?? "/tmp", `pickup-finder-e2e-${Date.now()}`);
const scenarios = process.argv.slice(2).map((s) => { const [url, postal] = s.split("|"); return { url, postal }; });
if (!scenarios.length) { console.error('usage: node tools/e2e-popup.mjs "<product url>|<postal code>" ...'); process.exit(2); }

const chrome = spawn(CHROME, [`--remote-debugging-port=${PORT}`, "--enable-unsafe-extension-debugging", `--user-data-dir=${PROFILE}`, "--no-first-run", "--no-default-browser-check", "about:blank"], { stdio: "ignore" });
let id = 0; const waiters = new Map(); let ws;
const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const i = ++id; waiters.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) })); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const finish = (code) => { chrome.kill(); setTimeout(() => { try { rmSync(PROFILE, { recursive: true, force: true }); } catch {} process.exit(code); }, 1500); };

try {
  await sleep(3000);
  const v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  ws = new WebSocket(v.webSocketDebuggerUrl);
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); const w = waiters.get(m.id); if (!w) return; waiters.delete(m.id); m.error ? w.rej(new Error(m.error.message)) : w.res(m.result); };
  await new Promise((r) => (ws.onopen = r));
  const { id: extId } = await send("Extensions.loadUnpacked", { path: DIST });
  console.log("installed", extId);
  const popupUrl = `chrome-extension://${extId}/popup/popup.html`;
  let targetId, sessionId;
  const openPopup = async () => {
    ({ targetId } = await send("Target.createTarget", { url: popupUrl }));
    ({ sessionId } = await send("Target.attachToTarget", { targetId, flatten: true }));
    await sleep(1500);
  };
  const evalIn = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 500));
    return r.result.value;
  };
  await openPopup();
  const text = (sel) => `[...document.querySelectorAll(${JSON.stringify(sel)})].map((li) => li.innerText.replace(/\\s+/g, " ").trim())`;
  const snapshot = () => evalIn(`JSON.stringify({ error: document.getElementById("error").textContent, status: document.getElementById("status").textContent,
    item: document.getElementById("itemName").textContent, price: document.getElementById("itemPrice").textContent,
    notice: document.getElementById("itemNotice").hidden ? "" : document.getElementById("itemNotice").textContent,
    nearby: ${text("#stores .store")}, nearest: ${text("#nearestStores .store")}, note: document.getElementById("nearestNote").textContent,
    searchMore: !document.getElementById("searchMore").hidden, busy: document.getElementById("submit").disabled })`);
  for (const { url, postal } of scenarios) {
    console.log(`\n=== ${url} @ ${postal}`);
    await evalIn(`(() => { const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); };
      set("item", ${JSON.stringify(url)}); set("postal", ${JSON.stringify(postal)}); document.getElementById("form").requestSubmit(); return "submitted"; })()`);
    const t0 = Date.now();
    let last = "", quiet = 0, reopened = !process.env.REOPEN;
    while (Date.now() - t0 < 240000) { // the background may first open the retailer's tab (up to 15 s), then search up to 40 calls
      await sleep(2500);
      if (!reopened && Date.now() - t0 > 4000) {
        reopened = true;
        await send("Target.closeTarget", { targetId });
        console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] popup closed; reopening in 6 s`);
        await sleep(6000);
        await openPopup();
        console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] popup reopened`);
      }
      const snap = await snapshot();
      if (snap !== last) { console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, snap); last = snap; quiet = 0; } else quiet++;
      const s = JSON.parse(snap);
      if (!s.busy && !s.status && quiet >= 2) break;
    }
  }
  finish(0);
} catch (err) {
  console.error("e2e failed:", err.message);
  finish(1);
}
