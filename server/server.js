// DOS Harbor multiplayer relay.
//
// A tiny WebSocket server that replaces the public js-dos peer server. Each
// browser connects, gets a numeric peer id, can register room aliases, and
// sends emulated IPX packets to other peers through this relay.
//
// Wire protocol
//   text frames (JSON), client -> server
//     {t:"register", alias}            claim a room alias
//     {t:"unregister", alias}
//     {t:"query", q}                   "=name" exact match, otherwise prefix match
//   text frames (JSON), server -> client
//     {t:"welcome", id}                sent on connect
//     {t:"registered", alias, ok}
//     {t:"aliases", q, list:[{alias, peerId}]}
//     {t:"left", id}                   a peer you exchanged packets with disconnected
//   binary frames
//     client -> server: [u32 LE destination peer id][payload]
//     server -> client: [u32 LE source peer id][payload]
//
// Env: PORT (default 8787), ALLOWED_ORIGINS (comma-separated; empty = allow all)

import { createServer } from "node:http";
import { randomInt } from "node:crypto";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT) || 8787;
const ALLOWED = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim().replace(/\/+$/, ""))
  .filter(Boolean);
const MAX_PACKET = 64 * 1024;
const MAX_ALIASES_PER_PEER = 4;
const MAX_PACKETS_PER_SEC = 2000;

/** @type {Map<number, import("ws").WebSocket>} */
const peers = new Map();
/** @type {Map<string, number>} alias -> peer id */
const aliases = new Map();

function newPeerId() {
  for (;;) {
    const id = randomInt(1, 0x7fffffff);
    if (!peers.has(id)) return id;
  }
}

const http = createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain", "Access-Control-Allow-Origin": "*" });
  res.end(`dosharbor relay ok\npeers ${peers.size}\nrooms ${aliases.size}\n`);
});

const wss = new WebSocketServer({
  server: http,
  maxPayload: MAX_PACKET + 4,
  verifyClient: ({ origin }) => !ALLOWED.length || ALLOWED.includes(String(origin || "").replace(/\/+$/, "")),
});

wss.on("connection", (ws) => {
  const id = newPeerId();
  const mine = new Set(); // aliases owned by this peer
  const contacts = new Set(); // peers we exchanged packets with
  let windowStart = Date.now();
  let packets = 0;

  ws.peerId = id;
  ws.contacts = contacts;
  peers.set(id, ws);
  ws.send(JSON.stringify({ t: "welcome", id }));

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      const now = Date.now();
      if (now - windowStart > 1000) { windowStart = now; packets = 0; }
      if (++packets > MAX_PACKETS_PER_SEC) return;

      const buf = Buffer.isBuffer(data) ? data : Buffer.concat(data);
      if (buf.length < 5) return;
      const dest = buf.readUInt32LE(0);
      const target = peers.get(dest);
      if (!target || target.readyState !== target.OPEN) return;
      const out = Buffer.allocUnsafe(buf.length);
      out.writeUInt32LE(id, 0);
      buf.copy(out, 4, 4);
      contacts.add(dest);
      target.contacts.add(id);
      target.send(out, { binary: true });
      return;
    }

    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    const alias = typeof msg.alias === "string" ? msg.alias.slice(0, 64) : "";

    if (msg.t === "register" && alias) {
      const owner = aliases.get(alias);
      const ok = (owner === undefined || owner === id) && (mine.has(alias) || mine.size < MAX_ALIASES_PER_PEER);
      if (ok) { aliases.set(alias, id); mine.add(alias); }
      ws.send(JSON.stringify({ t: "registered", alias, ok }));
    } else if (msg.t === "unregister" && alias) {
      if (aliases.get(alias) === id) aliases.delete(alias);
      mine.delete(alias);
    } else if (msg.t === "query" && typeof msg.q === "string") {
      const q = msg.q.slice(0, 65);
      let list;
      if (q.startsWith("=")) {
        const peerId = aliases.get(q.slice(1));
        list = peerId ? [{ alias: q.slice(1), peerId }] : [];
      } else {
        list = [];
        for (const [a, peerId] of aliases) {
          if (a.startsWith(q)) list.push({ alias: a, peerId });
          if (list.length >= 100) break;
        }
      }
      ws.send(JSON.stringify({ t: "aliases", q: msg.q, list }));
    }
  });

  ws.on("close", () => {
    peers.delete(id);
    for (const a of mine) if (aliases.get(a) === id) aliases.delete(a);
    for (const c of contacts) {
      const other = peers.get(c);
      if (other && other.readyState === other.OPEN) {
        other.contacts.delete(id);
        other.send(JSON.stringify({ t: "left", id }));
      }
    }
  });

  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));
});

// Drop dead connections (closed laptops, lost Wi-Fi).
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000).unref();

http.listen(PORT, () => {
  console.log(`dosharbor relay listening on :${PORT}` + (ALLOWED.length ? ` (origins: ${ALLOWED.join(", ")})` : ""));
});
