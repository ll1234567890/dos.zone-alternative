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
//   connect URL: wss://host/                    new session
//                wss://host/?resume=<id>&token=<token>   reclaim a dropped session
//   text frames (JSON), server -> client
//     {t:"welcome", id, token, resumed}  sent on connect; resumed=false when a
//                                      resume was asked for but has expired
//     {t:"registered", alias, ok}
//     {t:"aliases", q, list:[{alias, peerId}]}
//     {t:"left", id}                   a peer you exchanged packets with disconnected
//   binary frames
//     client -> server: [u32 LE destination peer id][payload]
//     server -> client: [u32 LE source peer id][payload]
//
// A dropped socket (hidden tab, flaky Wi-Fi, laptop lid) keeps its peer id,
// rooms and contacts for GRACE_MS so the browser can reconnect as the same
// player and the emulated IPX session carries on. Packets sent to it in the
// meantime are buffered (up to a limit) and delivered on resume.
//
// Env: PORT (default 8787), ALLOWED_ORIGINS (comma-separated; empty = allow all),
//      GRACE_MS (default 180000 = 3 minutes)

import { createServer } from "node:http";
import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT) || 8787;
const ALLOWED = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim().replace(/\/+$/, ""))
  .filter(Boolean);
const MAX_PACKET = 64 * 1024;
const MAX_ALIASES_PER_PEER = 4;
const MAX_PACKETS_PER_SEC = 2000;
const GRACE_MS = Number(process.env.GRACE_MS) || 180000;
const MAX_PENDING = 1024; // packets buffered for a disconnected peer

/**
 * @typedef {{ id: number, token: string, ws: import("ws").WebSocket | null,
 *   mine: Set<string>, contacts: Set<number>, pending: Buffer[], graceTimer: NodeJS.Timeout | null }} Session
 * @type {Map<number, Session>}
 */
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
  let online = 0;
  for (const p of peers.values()) if (p.ws) online++;
  res.end(`dosharbor relay ok\npeers ${peers.size} (${online} connected)\nrooms ${aliases.size}\n`);
});

const wss = new WebSocketServer({
  server: http,
  maxPayload: MAX_PACKET + 4,
  verifyClient: ({ origin }) => !ALLOWED.length || ALLOWED.includes(String(origin || "").replace(/\/+$/, "")),
});

function sameToken(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

function deliver(target, buf) {
  if (target.ws && target.ws.readyState === target.ws.OPEN) {
    target.ws.send(buf, { binary: true });
  } else if (target.pending.length < MAX_PENDING) {
    target.pending.push(buf);
  }
}

/** Forget a session for good: free its rooms and tell its contacts. */
function endSession(session) {
  if (peers.get(session.id) !== session) return;
  peers.delete(session.id);
  for (const a of session.mine) if (aliases.get(a) === session.id) aliases.delete(a);
  for (const c of session.contacts) {
    const other = peers.get(c);
    if (!other) continue;
    other.contacts.delete(session.id);
    if (other.ws && other.ws.readyState === other.ws.OPEN) {
      other.ws.send(JSON.stringify({ t: "left", id: session.id }));
    }
  }
}

wss.on("connection", (ws, req) => {
  const params = new URL(req.url || "/", "http://relay").searchParams;
  const wantId = Number(params.get("resume"));
  let session = wantId ? peers.get(wantId) : undefined;
  const resumed = !!session && sameToken(session.token, params.get("token"));

  if (resumed) {
    clearTimeout(session.graceTimer);
    session.graceTimer = null;
    if (session.ws && session.ws !== ws) {
      session.ws.removeAllListeners("close");
      session.ws.terminate();
    }
    session.ws = ws;
  } else {
    session = {
      id: newPeerId(), token: randomBytes(16).toString("hex"), ws,
      mine: new Set(), contacts: new Set(), pending: [], graceTimer: null,
    };
    peers.set(session.id, session);
  }
  const { id, mine, contacts } = session;
  let windowStart = Date.now();
  let packets = 0;

  ws.send(JSON.stringify({ t: "welcome", id, token: session.token, resumed: wantId ? resumed : undefined }));
  // packets that arrived while this peer was away
  for (const buf of session.pending.splice(0)) ws.send(buf, { binary: true });

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      const now = Date.now();
      if (now - windowStart > 1000) { windowStart = now; packets = 0; }
      if (++packets > MAX_PACKETS_PER_SEC) return;

      const buf = Buffer.isBuffer(data) ? data : Buffer.concat(data);
      if (buf.length < 5) return;
      const dest = buf.readUInt32LE(0);
      const target = peers.get(dest);
      if (!target) return;
      const out = Buffer.allocUnsafe(buf.length);
      out.writeUInt32LE(id, 0);
      buf.copy(out, 4, 4);
      contacts.add(dest);
      target.contacts.add(id);
      deliver(target, out);
      return;
    }

    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    const alias = typeof msg.alias === "string" ? msg.alias.slice(0, 64) : "";

    if (msg.t === "ping") {
      ws.send(JSON.stringify({ t: "pong" }));
    } else if (msg.t === "register" && alias) {
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
    } else if (msg.t === "bye") {
      // the player left on purpose: no grace period
      ws.removeAllListeners("close");
      endSession(session);
      ws.close();
    }
  });

  ws.on("close", () => {
    if (session.ws !== ws) return;
    session.ws = null;
    session.graceTimer = setTimeout(() => endSession(session), GRACE_MS);
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
