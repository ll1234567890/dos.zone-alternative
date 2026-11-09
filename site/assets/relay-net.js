// Browser side of the DOS Harbor relay (see server/server.js).
// Implements the js-dos `NetInstance` interface, so it can be handed to js-dos
// as `sharedNet` in place of its built-in WebRTC networking.
//
// If the socket drops (hidden tab, Wi-Fi blip, sleeping laptop) it reconnects
// and resumes the same server session, so the peer id and the running game
// survive. Outgoing packets are queued meanwhile.

const KEEPALIVE_MS = 20000;
const MAX_OUTBOX = 1024;
const GIVE_UP_MS = 170000; // a little under the server's default grace period

/**
 * Connect to the relay and resolve once it has assigned a peer id.
 * @param {string} url  ws:// or wss:// URL of the relay
 * @param {{onLog?(msg: string, important?: boolean): void}} hooks
 */
export function connectRelay(url, hooks = {}) {
  const log = hooks.onLog || (() => {});
  return new Promise((resolve, reject) => {
    const inbox = [];
    const queries = new Map(); // q -> [resolve...]
    const registers = new Map(); // alias -> {resolve, reject}
    const outbox = []; // packets sent while disconnected
    let ws;
    let settled = false;
    let closedByUs = false;
    let token = "";
    let lostAt = 0; // when the current outage began (0 = connected)
    let retryTimer = null;
    let retryDelay = 500;

    const net = {
      peerId: 0,
      connected: new Set(),
      wait: () => {},
      registerAlias(alias) {
        return new Promise((res, rej) => {
          registers.set(alias, { resolve: res, reject: rej });
          send({ t: "register", alias });
        });
      },
      unregisterAlias(alias) {
        send({ t: "unregister", alias });
      },
      queryAliases(q) {
        return new Promise((res) => {
          if (!queries.has(q)) queries.set(q, []);
          queries.get(q).push(res);
          if (!send({ t: "query", q })) setTimeout(() => flushQuery(q, []), 500);
        });
      },
      sendBinary(data, peerId) {
        if (peerId === net.peerId || peerId === 0) throw new Error("Cannot send to self (" + peerId + ")");
        const frame = new Uint8Array(4 + data.byteLength);
        new DataView(frame.buffer).setUint32(0, peerId >>> 0, true);
        frame.set(data, 4);
        net.connected.add(peerId);
        if (ws && ws.readyState === WebSocket.OPEN && !lostAt) {
          ws.send(frame);
        } else {
          if (outbox.length >= MAX_OUTBOX) outbox.shift();
          outbox.push(frame);
        }
        return data.byteLength || 1;
      },
      recvBinary() {
        return inbox.shift() || null;
      },
      disconnect(peerId) {
        net.connected.delete(peerId);
      },
      // js-dos calls shutdown() whenever it restarts the emulator and then
      // reuses this same instance, so keep the socket open. Close on page exit.
      shutdown() {},
      close() {
        closedByUs = true;
        clearTimeout(retryTimer);
        if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "bye" }));
        ws?.close();
      },
    };

    function send(obj) {
      if (!ws || ws.readyState !== WebSocket.OPEN) return false;
      ws.send(JSON.stringify(obj));
      return true;
    }

    function flushQuery(q, list) {
      const waiting = queries.get(q) || [];
      queries.delete(q);
      for (const res of waiting) res(list);
    }

    function open(attempt) {
      const resuming = settled && token;
      const target = resuming
        ? `${url}${url.includes("?") ? "&" : "?"}resume=${net.peerId}&token=${encodeURIComponent(token)}`
        : url;
      if (!settled) log(attempt ? `reconnecting to ${url}…` : `connecting to ${url}…`);
      const sock = new WebSocket(target);
      ws = sock;
      sock.binaryType = "arraybuffer";

      sock.onmessage = (ev) => {
        if (typeof ev.data !== "string") {
          const buf = new Uint8Array(ev.data);
          if (buf.length < 5) return;
          const from = new DataView(ev.data).getUint32(0, true);
          net.connected.add(from);
          inbox.push({ data: buf.slice(4), peerId: from });
          return;
        }
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.t === "welcome") {
          if (resuming && msg.resumed === false) {
            // the server already gave up on our old session
            closedByUs = true;
            sock.send(JSON.stringify({ t: "bye" })); // free the fresh session the server opened
            sock.close();
            log("multiplayer session expired while you were away; leave and rejoin the room", true);
            return;
          }
          net.peerId = msg.id;
          token = msg.token || token;
          retryDelay = 500;
          if (resuming) {
            log(`reconnected to relay after ${Math.round((Date.now() - lostAt) / 1000)} s, peer id ${msg.id}`);
          } else {
            log(`connected to relay, peer id ${msg.id}`);
          }
          lostAt = 0;
          for (const frame of outbox.splice(0)) sock.send(frame);
          if (!settled) { settled = true; resolve(net); }
        } else if (msg.t === "registered") {
          const p = registers.get(msg.alias);
          registers.delete(msg.alias);
          if (p) msg.ok ? p.resolve() : p.reject(new Error("Alias already in use"));
        } else if (msg.t === "aliases") {
          flushQuery(msg.q, msg.list || []);
        } else if (msg.t === "left") {
          net.connected.delete(msg.id);
          log(`peer ${msg.id} left`);
        }
      };

      sock.onclose = () => {
        if (closedByUs || sock !== ws) return;
        if (!settled) {
          if (attempt >= 4) {
            settled = true;
            log(`could not reach the multiplayer relay at ${url}`, true);
            reject(new Error("Could not reach the multiplayer relay"));
            return;
          }
          retryTimer = setTimeout(() => open(attempt + 1), 1000 * (attempt + 1));
          return;
        }
        if (!lostAt) {
          lostAt = Date.now();
          log("connection to the relay dropped, reconnecting…");
        }
        scheduleReconnect();
      };
    }

    function scheduleReconnect(now = false) {
      clearTimeout(retryTimer);
      if (closedByUs) return;
      if (!now && Date.now() - lostAt > GIVE_UP_MS) {
        log("could not reconnect to the multiplayer relay; leave and rejoin the room", true);
        return;
      }
      retryTimer = setTimeout(() => open(1), now ? 0 : retryDelay);
      retryDelay = Math.min(retryDelay * 2, 5000);
    }

    // Background tabs get throttled timers, so retry right away when the
    // player comes back instead of waiting for the next backoff step.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && settled && lostAt && ws?.readyState !== WebSocket.CONNECTING) {
        retryDelay = 500;
        scheduleReconnect(true);
      }
    });

    // Keep idle connections alive through proxies and load balancers.
    setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "ping" }));
    }, KEEPALIVE_MS);

    window.addEventListener("pagehide", () => net.close());
    open(0);
  });
}
