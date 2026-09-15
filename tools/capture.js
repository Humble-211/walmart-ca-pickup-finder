// Capture walmart.ca network traffic from a Chrome started with
// --remote-debugging-port=9222. Writes JSONL to walmart-capture.jsonl.
// Cookies and set-cookie headers are stripped before writing.
const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "..", "walmart-capture.jsonl");
const PORT = 9222;
const HOST_RE = /walmart\.ca/i;

const pending = new Map(); // requestId -> {sessionId, req}
let msgId = 0;
const waiters = new Map();
let ws;

function send(method, params = {}, sessionId) {
  const id = ++msgId;
  const msg = { id, method, params };
  if (sessionId) msg.sessionId = sessionId;
  ws.send(JSON.stringify(msg));
  return new Promise((resolve, reject) => waiters.set(id, { resolve, reject }));
}

function stripHeaders(h = {}) {
  const out = {};
  for (const [k, v] of Object.entries(h)) {
    if (/^(cookie|set-cookie)$/i.test(k)) continue;
    out[k] = v;
  }
  return out;
}

async function attachAll() {
  const { targetInfos } = await send("Target.getTargets");
  for (const t of targetInfos) if (t.type === "page") await attach(t.targetId);
}

async function attach(targetId) {
  try {
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    await send("Network.enable", { maxPostDataSize: 1 << 20 }, sessionId);
    console.log("attached", targetId);
  } catch (e) {
    console.log("attach failed", targetId, e.message);
  }
}

async function onEvent(msg) {
  const { method, params, sessionId } = msg;
  if (method === "Target.targetCreated" && params.targetInfo.type === "page") {
    await attach(params.targetInfo.targetId);
    return;
  }
  if (method === "Network.requestWillBeSent") {
    const r = params.request;
    if (!HOST_RE.test(r.url)) return;
    pending.set(params.requestId, {
      sessionId,
      req: { url: r.url, method: r.method, headers: stripHeaders(r.headers), postData: r.postData },
      ts: new Date().toISOString(),
    });
    return;
  }
  if (method === "Network.requestWillBeSentExtraInfo") {
    const p = pending.get(params.requestId);
    if (p) p.req.headers = { ...p.req.headers, ...stripHeaders(params.headers) };
    return;
  }
  if (method === "Network.responseReceived") {
    const p = pending.get(params.requestId);
    if (!p) return;
    p.res = {
      status: params.response.status,
      mimeType: params.response.mimeType,
      headers: stripHeaders(params.response.headers),
    };
    return;
  }
  if (method === "Network.loadingFinished") {
    const p = pending.get(params.requestId);
    if (!p) return;
    pending.delete(params.requestId);
    let body = null;
    const mt = p.res?.mimeType || "";
    if (/json|javascript|text\/plain/i.test(mt) || /graphql|api/i.test(p.req.url)) {
      try {
        const b = await send("Network.getResponseBody", { requestId: params.requestId }, p.sessionId);
        body = b.base64Encoded ? Buffer.from(b.body, "base64").toString("utf8") : b.body;
        if (body.length > 2_000_000) body = body.slice(0, 2_000_000) + "...[truncated]";
      } catch (e) {
        body = "[body unavailable: " + e.message + "]";
      }
    }
    fs.appendFileSync(OUT, JSON.stringify({ ts: p.ts, ...p.req, response: { ...p.res, body } }) + "\n");
    console.log(p.res?.status, p.req.method, p.req.url.slice(0, 120));
  }
}

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  ws = new WebSocket(list.webSocketDebuggerUrl);
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && waiters.has(msg.id)) {
      const w = waiters.get(msg.id);
      waiters.delete(msg.id);
      msg.error ? w.reject(new Error(msg.error.message)) : w.resolve(msg.result);
    } else if (msg.method) {
      onEvent(msg).catch((e) => console.error("event error", e.message));
    }
  };
  await new Promise((r) => (ws.onopen = r));
  await send("Target.setDiscoverTargets", { discover: true });
  await attachAll();
  console.log("capturing to", OUT);
}
main().catch((e) => { console.error(e); process.exit(1); });
