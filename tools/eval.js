// Run a JS expression inside the first walmart.ca tab of the debug Chrome.
// usage: node tools/eval.js "<expression returning promise or value>"
const expr = process.argv[2];
let id = 0; const waiters = new Map(); let ws;
const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const i = ++id; waiters.set(i, { res, rej });
  ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
});
(async () => {
  const v = await (await fetch("http://127.0.0.1:9222/json/version")).json();
  ws = new WebSocket(v.webSocketDebuggerUrl);
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); const w = waiters.get(m.id); if (!w) return; waiters.delete(m.id); m.error ? w.rej(new Error(m.error.message)) : w.res(m.result); };
  await new Promise((r) => (ws.onopen = r));
  const { targetInfos } = await send("Target.getTargets");
  const t = targetInfos.find((x) => x.type === "page" && /walmart\.ca/.test(x.url));
  if (!t) throw new Error("no walmart.ca tab");
  const { sessionId } = await send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) console.error("EXC", JSON.stringify(r.exceptionDetails).slice(0, 800));
  const val = r.result.value;
  console.log(typeof val === "string" ? val : JSON.stringify(val, null, 1));
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
