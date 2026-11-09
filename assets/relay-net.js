// Browser side of the DOS Harbor relay (see server/server.js).
// Implements the js-dos `NetInstance` interface, so it can be handed to js-dos
// as `sharedNet` in place of its built-in WebRTC networking.

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
    let ws;
    let settled = false;
    let closedByUs = false;

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
        if (!ws || ws.readyState !== WebSocket.OPEN) return 0;
        if (peerId === net.peerId || peerId === 0) throw new Error("Cannot send to self (" + peerId + ")");
        const frame = new Uint8Array(4 + data.byteLength);
        new DataView(frame.buffer).setUint32(0, peerId >>> 0, true);
        frame.set(data, 4);
        ws.send(frame);
        net.connected.add(peerId);
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
      log(attempt ? `reconnecting to ${url}…` : `connecting to ${url}…`);
      ws = new WebSocket(url);
      ws.binaryType = "arraybuffer";

      ws.onmessage = (ev) => {
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
          net.peerId = msg.id;
          log(`connected to relay, peer id ${msg.id}`);
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

      ws.onclose = () => {
        if (closedByUs) return;
        if (!settled) {
          if (attempt >= 4) {
            settled = true;
            log(`could not reach the multiplayer relay at ${url}`, true);
            reject(new Error("Could not reach the multiplayer relay"));
            return;
          }
        } else {
          // A new socket means a new peer id, so the running game session
          // can't continue. Tell the player instead of silently retrying.
          log("lost connection to the multiplayer relay; leave and rejoin the room", true);
          return;
        }
        setTimeout(() => open(attempt + 1), 1000 * (attempt + 1));
      };
    }

    window.addEventListener("pagehide", () => net.close());
    open(0);
  });
}
