// Shared player logic: read the player's own game files, keep bundles in the
// browser, and launch them in single-player, host or join mode.
//
// Multiplayer: the host starts an IPX server inside DOSBox and registers a
// short room alias; joiners look the alias up and connect. Packets go through
// our own relay (server/, configured in config.js) or, if none is configured,
// js-dos' built-in WebRTC networking via the public net.dos.zone server.

import { RELAY_URL } from "./config.js";
import { connectRelay } from "./relay-net.js";

const VENDOR = new URL("../vendor/", import.meta.url);
export const EMULATORS_PATH = new URL("js-dos/emulators/", VENDOR).href;
const ROOM_PREFIX = "dosharbor-";

/* ------------------------------------------------------------------ storage */

const DB_NAME = "dosharbor";
const STORE = "bundles";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const storage = {
  /** @returns {Promise<{blob: Blob, info: object} | undefined>} */
  get: (id) => tx("readonly", (s) => s.get(id)),
  put: (id, value) => tx("readwrite", (s) => s.put(value, id)),
  remove: (id) => tx("readwrite", (s) => s.delete(id)),
  keys: () => tx("readonly", (s) => s.getAllKeys()),
};

/* ------------------------------------------------------------ reading input */

/** Read a FileList (zip, .jsdos, or a picked folder) into {path: Uint8Array}. */
export async function readInput(files, onProgress = () => {}) {
  const list = [...files];
  if (list.length === 1 && /\.(zip|jsdos)$/i.test(list[0].name)) {
    onProgress(`Reading ${list[0].name}…`);
    const bytes = new Uint8Array(await list[0].arrayBuffer());
    onProgress("Unpacking archive…");
    return unzip(bytes);
  }
  const out = {};
  let i = 0;
  for (const f of list) {
    const path = (f.webkitRelativePath || f.relPath || f.name).replace(/^\/+/, "");
    if (++i % 25 === 0) onProgress(`Reading files… ${i}/${list.length}`);
    out[path] = new Uint8Array(await f.arrayBuffer());
  }
  return out;
}

/** Collect files from a drag & drop, including dropped folders. */
export async function filesFromDrop(dataTransfer) {
  const items = [...(dataTransfer.items || [])];
  const entries = items.map((it) => it.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return [...dataTransfer.files];
  const files = [];
  const walk = async (entry, prefix) => {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      file.relPath = prefix + file.name;
      files.push(file);
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      let batch;
      do {
        batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        for (const e of batch) await walk(e, prefix + entry.name + "/");
      } while (batch.length);
    }
  };
  for (const e of entries) await walk(e, "");
  return files;
}

export function unzip(bytes) {
  return new Promise((resolve, reject) => {
    // async unzip keeps the page responsive on large archives
    window.fflate.unzip(bytes, (err, data) => (err ? reject(err) : resolve(data)));
  });
}

export function zip(files) {
  return new Promise((resolve, reject) => {
    // level 0: DOS games are small and already-compressed data gains little
    window.fflate.zip(files, { level: 0 }, (err, data) => (err ? reject(err) : resolve(data)));
  });
}

/* ---------------------------------------------------------- bundle editing */

/**
 * Replace .jsdos/dosbox.conf inside a stored bundle (a new config string, or a
 * function old => new).
 * @returns {Promise<Blob|null>} the updated bundle, or null if unchanged
 */
export async function updateBundleConf(blob, confOrFn) {
  const files = await unzip(new Uint8Array(await blob.arrayBuffer()));
  const key = Object.keys(files).find((p) => p.toLowerCase() === ".jsdos/dosbox.conf");
  const old = key ? new TextDecoder().decode(files[key]) : "";
  const conf = typeof confOrFn === "function" ? confOrFn(old) : confOrFn;
  if (key && old === conf) return null;
  files[key || ".jsdos/dosbox.conf"] = new TextEncoder().encode(conf);
  return new Blob([await zip(files)], { type: "application/zip" });
}

/* --------------------------------------------------------------- launching */

/** Delete js-dos' saved file changes for a game (settings, saved games). */
export async function resetChanges(gameId) {
  const name = `dosharbor-${gameId}.changes`.replace(/[^a-zA-Z0-9._-]/g, "_");
  try {
    const root = await navigator.storage.getDirectory();
    const saves = await (await root.getDirectoryHandle("jsdos")).getDirectoryHandle("saves");
    await saves.removeEntry(name);
    return true;
  } catch {
    return false; // nothing saved yet
  }
}

/** js-dos caches every bundle URL in OPFS. Our blob: URLs change on every
 * launch, so drop old blob entries to stop storage from growing. */
async function cleanBlobCache() {
  if (!navigator.storage?.getDirectory) return;
  const walk = async (dir, depth) => {
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === "directory" && depth < 4) await walk(handle, depth + 1);
      else if (handle.kind === "file" && name.startsWith("blob_")) {
        await dir.removeEntry(name).catch(() => {});
      }
    }
  };
  try {
    await walk(await navigator.storage.getDirectory(), 0);
  } catch (e) {
    console.warn("OPFS cleanup skipped", e);
  }
}

const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
export function newRoomCode() {
  const r = crypto.getRandomValues(new Uint8Array(6));
  return [...r].map((b) => ALPHABET[b % ALPHABET.length]).join("");
}

export function normalizeRoom(input) {
  let s = String(input || "").trim();
  try {
    // accept a full share link
    const u = new URL(s);
    s = u.searchParams.get("join") || s;
  } catch {}
  s = s.toLowerCase().replace(/^dosharbor-/, "");
  if (/^\d+$/.test(s)) return { code: s, address: s }; // raw js-dos peer id
  s = s.replace(/[^a-z0-9]/g, "");
  return s ? { code: s, address: ROOM_PREFIX + s } : null;
}

/**
 * Start the emulator.
 * @param {HTMLElement} el
 * @param {Blob} blob   bundle
 * @param {object} o    { gameId, mode: "solo"|"host"|"join", room?: {address}, onRoom?(info), onPeerId?(id) }
 */
export async function launch(el, blob, o) {
  await cleanBlobCache();
  // see scripts/build.mjs: plain audio by default, ?audio=worklet to compare
  window.__dosharborAudioWorklet = new URLSearchParams(location.search).get("audio") === "worklet";
  const url = URL.createObjectURL(blob);
  const options = {
    url,
    pathPrefix: EMULATORS_PATH,
    backend: o.backend || "dosbox",
    theme: "dark",
    autoStart: true,
    autoSave: true,
    noCloud: true,
    // Same rendering path dos.zone uses: the emulator worker draws straight
    // to an OffscreenCanvas, keeping frame copies off the main thread.
    offscreenCanvas: true,
    renderBackend: "canvas",
    // narrow sidebar on phones leaves more room for the game
    thinSidebar: window.matchMedia("(max-width: 700px)").matches,
    // stable key so saved games survive reloads even though the URL is a blob
    fsChanges: { urlToKey: () => `dosharbor-${o.gameId}.changes` },
  };
  if (o.mode === "host") options.startIpxServer = true;
  if (o.mode === "join") options.connectIpxAddress = o.room.address;

  if (o.mode !== "solo") {
    const relay = relayUrl();
    if (relay) {
      // our own relay: hand js-dos a ready network instance
      const net = await connectRelay(relay, { onLog: o.onNetLog });
      window.net = net;
      options.sharedNet = net;
    } else {
      watchNetwork(o);
    }
  }
  const dos = window.Dos(el, options);

  if (o.mode === "host") hostRoom(o).catch((e) => o.onRoom?.({ error: e.message }));
  return dos;
}

/** Relay in use: `?server=` parameter, else config.js, else none (net.dos.zone). */
export function relayUrl() {
  const param = new URLSearchParams(location.search).get("server");
  if (param && /^wss?:\/\//.test(param)) return param;
  return RELAY_URL || "";
}

// The WebRTC networking library only reports problems on the console. Mirror
// the relevant lines to the page, and warn if no peer id arrives in time.
const NET_LOG = /signal|websocket|hello failed|peer id|connect failed|alias|blacklist|connection to peer|network error/i;
function watchNetwork(o) {
  for (const level of ["log", "info", "warn", "error"]) {
    const orig = console[level].bind(console);
    console[level] = (...args) => {
      orig(...args);
      const msg = args.map(String).join(" ");
      if (NET_LOG.test(msg) && msg.length < 300) o.onNetLog?.(msg.trim());
    };
  }
  setTimeout(() => {
    if (!window.net?.peerId) {
      o.onNetLog?.(
        "Still no connection to the multiplayer server (net.dos.zone) after 20 s. " +
          "Ad/tracker blockers, Brave Shields, VPNs or strict firewalls can block it. " +
          "Try disabling them for this site, or another network/browser.",
        true,
      );
    }
  }, 20000);
}

async function waitForNet() {
  for (;;) {
    const id = window.net?.peerId;
    if (id) return window.net;
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function hostRoom(o) {
  const net = await waitForNet();
  o.onPeerId?.(net.peerId);
  let code = o.preferredCode || newRoomCode();
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await net.registerAlias(ROOM_PREFIX + code);
      o.onRoom?.({ code, peerId: net.peerId });
      return;
    } catch (e) {
      console.warn("room alias failed", e);
      code = newRoomCode();
    }
  }
  // Alias registration failed: friends can still join by numeric id.
  o.onRoom?.({ code: String(net.peerId), peerId: net.peerId });
}
