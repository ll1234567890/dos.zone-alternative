// Custom game page: any DOS game folder, zip or .jsdos bundle, with every
// DOSBox setting editable. Games are stored in IndexedDB as "custom:<id>".
import { storage, readInput, filesFromDrop, zip, updateBundleConf, resetChanges } from "../../assets/player.js";
import { startGame } from "../../assets/game-page.js";
import { initPerfHint } from "../../assets/perf-hint.js";
import { getValue, setValue, getAutoexec, setAutoexec, baseConf, launchScript } from "../../assets/dosconf.js";

const $ = (id) => document.getElementById(id);
const PREFIX = "custom:";
const KEEP = "__keep__"; // program option: keep a .jsdos bundle's own startup
const params = new URLSearchParams(location.search);

let current = null; // stored record of the selected game
let conf = ""; // working dosbox.conf (may be unsaved)
let dirty = false;

const status = (msg, kind = "") => {
  $("status").textContent = msg;
  $("status").className = "status " + kind;
};

/* ------------------------------------------------------------ file → bundle */

const DOS_NAME = /^[A-Z0-9_\-~!#$%&'()@^{}]{1,8}(\.[A-Z0-9_\-~!#$%&'()@^{}]{1,3})?$/i;
const PROGRAM = /\.(exe|com|bat)$/i;
const UNLIKELY = /^(setup|install|instal|uninst|uninstal|config|setsound|sound|soundset|readme|order|catalog|patch|dos4gw|pmode|cwsdpmi|lha|pkunzip|unzip|ultramid|ipxsetup|serial|modem)/i;

/** Map long or invalid path parts to 8.3 DOS names, consistently per folder. */
function dosPaths(paths) {
  const taken = new Map(); // parent -> Set of used names
  const memo = new Map(); // parent + "/" + original -> dos name
  const nameFor = (parent, part) => {
    const key = parent + "/" + part;
    if (memo.has(key)) return memo.get(key);
    if (!taken.has(parent)) taken.set(parent, new Set());
    const used = taken.get(parent);
    let name;
    if (DOS_NAME.test(part) && !used.has(part.toUpperCase())) {
      name = part.toUpperCase();
    } else {
      const dot = part.lastIndexOf(".");
      const base = (dot > 0 ? part.slice(0, dot) : part).toUpperCase().replace(/[^A-Z0-9_]/g, "") || "FILE";
      const ext = dot > 0 ? part.slice(dot + 1).toUpperCase().replace(/[^A-Z0-9_]/g, "").slice(0, 3) : "";
      for (let n = 1; ; n++) {
        const tail = "~" + n;
        name = base.slice(0, 8 - tail.length) + tail + (ext ? "." + ext : "");
        if (!used.has(name)) break;
      }
    }
    used.add(name);
    memo.set(key, name);
    return name;
  };
  return paths.map((p) => {
    const parts = p.split("/");
    let parent = "";
    return parts.map((part) => {
      const n = nameFor(parent, part);
      parent += "/" + n;
      return n;
    }).join("/");
  });
}

function rankPrograms(programs, sizes) {
  return programs.slice().sort((a, b) => {
    const score = (p) => {
      const file = p.split("\\").pop();
      let s = 0;
      if (UNLIKELY.test(file)) s -= 100;
      if (/\.exe$/i.test(file)) s += 10;
      if (/\.bat$/i.test(file)) s += 5;
      s -= (p.split("\\").length - 1) * 8; // prefer shallow
      s += Math.min(20, (sizes[p] || 0) / 100000); // prefer bigger programs
      return s;
    };
    return score(b) - score(a);
  });
}

async function addGame(fileList, sourceName) {
  if (!fileList?.length) return;
  try {
    status("Reading files…");
    const raw = await readInput(fileList, (m) => status(m));
    let paths = Object.keys(raw).filter((p) => !p.endsWith("/") && !p.startsWith("__MACOSX/") && !/(^|\/)\.DS_Store$/.test(p));
    const files = {};
    let newConf;
    let source;
    const confKey = paths.find((p) => p.toLowerCase() === ".jsdos/dosbox.conf");

    if (confKey) {
      // a js-dos bundle: keep files and config as they are
      source = "jsdos";
      for (const p of paths) files[p] = raw[p];
      newConf = new TextDecoder().decode(raw[confKey]);
    } else {
      source = "files";
      // drop a single shared top folder, then use DOS-safe names
      const tops = new Set(paths.map((p) => p.split("/")[0]));
      if (tops.size === 1 && paths.every((p) => p.includes("/"))) {
        const top = [...tops][0] + "/";
        paths = paths.map((p) => p.slice(top.length));
        for (const p of Object.keys(raw)) if (p.startsWith(top)) raw[p.slice(top.length)] = raw[p];
      }
      const dos = dosPaths(paths);
      paths.forEach((p, i) => (files[dos[i]] = raw[p]));
    }

    const all = Object.keys(files).filter((p) => !p.toLowerCase().startsWith(".jsdos/"));
    const sizes = {};
    const programs = all.filter((p) => PROGRAM.test(p)).map((p) => {
      const d = p.replace(/\//g, "\\").toUpperCase();
      sizes[d] = files[p].byteLength;
      return d;
    });
    const ranked = rankPrograms(programs, sizes);
    const cd = all.find((p) => /\.cue$/i.test(p)) || all.find((p) => /\.iso$/i.test(p));
    const cdImage = cd ? cd.replace(/\//g, "\\") : null;

    if (source === "files") {
      if (!ranked.length) throw new Error("No .EXE, .COM or .BAT program found in these files.");
      newConf = setAutoexec(baseConf(), launchScript(ranked[0], cdImage));
    }
    files[".jsdos/dosbox.conf"] = new TextEncoder().encode(newConf);
    files[".jsdos/jsdos.json"] = files[".jsdos/jsdos.json"] || new TextEncoder().encode(JSON.stringify({ version: "js-dos-v8" }));

    status("Packing…");
    const blob = new Blob([await zip(files)], { type: "application/zip" });
    const name = (sourceName || "Custom game").replace(/\.(zip|jsdos)$/i, "");
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const record = {
      id, name, blob, conf: newConf, programs: ranked, cdImage, source,
      program: source === "files" ? ranked[0] : KEEP,
      backend: /sockdrive|\.qcow2/i.test(newConf) ? "dosboxX" : "dosbox",
      savedAt: Date.now(),
    };
    await storage.put(PREFIX + id, record);
    await refreshList(id);
    status(`Added "${name}". Check the settings, then play.`, "ok");
  } catch (e) {
    console.error(e);
    status(e.message || String(e), "err");
  }
}

/* ------------------------------------------------------------- list & select */

async function refreshList(selectId) {
  const keys = (await storage.keys()).filter((k) => String(k).startsWith(PREFIX));
  const records = [];
  for (const k of keys) records.push(await storage.get(k));
  records.sort((a, b) => b.savedAt - a.savedAt);
  const list = $("game-list");
  list.innerHTML = "";
  for (const r of records) list.append(new Option(`${r.name} (${(r.blob.size / 1048576).toFixed(1)} MB)`, r.id));
  $("game-list-row").classList.toggle("hidden", !records.length);
  const want = selectId || params.get("game") || records[0]?.id;
  if (want && records.some((r) => r.id === want)) {
    list.value = want;
    await select(want);
  } else {
    select(null);
  }
}

async function select(id) {
  current = id ? await storage.get(PREFIX + id) : null;
  const has = !!current;
  $("settings").classList.toggle("hidden", !has);
  $("play").classList.toggle("hidden", !has);
  $("add-panel").classList.toggle("hidden", has);
  if (!has) return;
  // remember the selection in the URL so invite links and Leave keep it
  const u = new URL(location.href);
  u.searchParams.set("game", id);
  history.replaceState(null, "", u);
  conf = current.conf;
  fillForm();
  setDirty(false);
}

/* --------------------------------------------------------------- the form */

const SB = ["sb16", "sbpro2", "sbpro1", "sb2", "sb1"];

function fillForm() {
  $("f-name").value = current.name;
  const prog = $("f-program");
  prog.innerHTML = "";
  if (current.source === "jsdos") {
    const startup = getAutoexec(conf).filter((l) => !/^@?echo|^#/i.test(l)).slice(-1)[0] || "";
    prog.append(new Option(`Keep the bundle's startup${startup ? ` (${startup})` : ""}`, KEEP));
  }
  for (const p of current.programs) prog.append(new Option("C:\\" + p, p));
  prog.value = current.program || KEEP;
  $("f-backend").value = current.backend || "dosbox";
  fieldsFromConf();
}

function fieldsFromConf() {
  const cycles = (getValue(conf, "cpu", "cycles") || "auto").toLowerCase();
  const known = [...$("f-cycles").options].some((o) => o.value === cycles);
  $("f-cycles").value = known ? cycles : "custom";
  $("f-cycles-custom").value = known ? "" : cycles;
  $("f-cycles-custom-wrap").classList.toggle("hidden", known);
  const mem = getValue(conf, "dosbox", "memsize") || "16";
  if (![...$("f-memsize").options].some((o) => o.value === mem)) $("f-memsize").append(new Option(mem + " MB", mem));
  $("f-memsize").value = mem;
  const machine = (getValue(conf, "dosbox", "machine") || "svga_s3").toLowerCase();
  if (![...$("f-machine").options].some((o) => o.value === machine)) $("f-machine").append(new Option(machine, machine));
  $("f-machine").value = machine;
  const sb = (getValue(conf, "sblaster", "sbtype") || "sb16").toLowerCase();
  const gus = /^true$/i.test(getValue(conf, "gus", "gus") || "");
  $("f-sound").value = gus ? "gus" : SB.includes(sb) ? sb : sb === "none" ? "none" : "sb16";
  $("f-autolock").checked = /^true$/i.test(getValue(conf, "sdl", "autolock") || "");
  $("f-ipx").checked = /^true$/i.test(getValue(conf, "ipx", "ipx") || "");
  $("f-conf").value = conf;
}

function confFromFields() {
  const cycles = $("f-cycles").value === "custom" ? $("f-cycles-custom").value.trim() || "auto" : $("f-cycles").value;
  $("f-cycles-custom-wrap").classList.toggle("hidden", $("f-cycles").value !== "custom");
  conf = setValue(conf, "cpu", "cycles", cycles);
  conf = setValue(conf, "dosbox", "memsize", $("f-memsize").value);
  conf = setValue(conf, "dosbox", "machine", $("f-machine").value);
  const sound = $("f-sound").value;
  conf = setValue(conf, "sblaster", "sbtype", sound === "gus" ? "sb16" : sound);
  conf = setValue(conf, "gus", "gus", sound === "gus" ? "true" : getValue(conf, "gus", "gus") !== undefined ? "false" : null);
  conf = setValue(conf, "sdl", "autolock", $("f-autolock").checked ? "true" : "false");
  conf = setValue(conf, "ipx", "ipx", $("f-ipx").checked ? "true" : "false");
  $("f-conf").value = conf;
  setDirty(true);
}

function setDirty(v) {
  dirty = v;
  $("save").disabled = !v;
  $("save").textContent = v ? "Save settings" : "Saved";
}

for (const id of ["f-cycles", "f-memsize", "f-machine", "f-sound", "f-autolock", "f-ipx"]) {
  $(id).addEventListener("change", confFromFields);
}
$("f-cycles-custom").addEventListener("input", confFromFields);
$("f-name").addEventListener("input", () => setDirty(true));
$("f-backend").addEventListener("change", () => setDirty(true));
$("f-program").addEventListener("change", () => {
  const p = $("f-program").value;
  if (p !== KEEP) {
    conf = setAutoexec(conf, launchScript(p, current.cdImage));
  } else {
    // back to the bundle's original startup
    conf = setAutoexec(conf, getAutoexec(current.originalConf || current.conf));
  }
  $("f-conf").value = conf;
  setDirty(true);
});
let confTimer;
$("f-conf").addEventListener("input", () => {
  clearTimeout(confTimer);
  confTimer = setTimeout(() => {
    conf = $("f-conf").value;
    const keepCursor = [$("f-conf").selectionStart, $("f-conf").selectionEnd];
    fieldsFromConf();
    $("f-conf").setSelectionRange(...keepCursor);
    setDirty(true);
  }, 300);
});

async function save() {
  if (!current) return;
  status("Saving…");
  const updated = await updateBundleConf(current.blob, conf);
  if (current.source === "jsdos" && !current.originalConf) current.originalConf = current.conf;
  current = {
    ...current,
    name: $("f-name").value.trim() || current.name,
    blob: updated || current.blob,
    conf,
    program: $("f-program").value,
    backend: $("f-backend").value,
    savedAt: Date.now(),
  };
  await storage.put(PREFIX + current.id, current);
  setDirty(false);
  const keepSel = current.id;
  await refreshList(keepSel);
  status("Settings saved.", "ok");
}
$("save").addEventListener("click", save);

/* ------------------------------------------------------------- other actions */

$("game-list").addEventListener("change", async (e) => {
  if (dirty && !confirm("Discard unsaved settings?")) {
    e.target.value = current.id;
    return;
  }
  await select(e.target.value);
});
$("add-new").addEventListener("click", () => {
  $("add-panel").classList.toggle("hidden");
});
$("pick-zip").onclick = () => $("in-zip").click();
$("pick-dir").onclick = () => $("in-dir").click();
$("in-zip").onchange = (e) => addGame(e.target.files, e.target.files[0]?.name);
$("in-dir").onchange = (e) => addGame(e.target.files, e.target.files[0]?.webkitRelativePath.split("/")[0]);
const drop = $("drop");
drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", async (e) => {
  e.preventDefault();
  drop.classList.remove("over");
  const files = await filesFromDrop(e.dataTransfer);
  const first = files[0];
  addGame(files, first?.relPath?.split("/")[0] || first?.name);
});

$("export").addEventListener("click", async () => {
  if (!current) return;
  if (dirty) await save();
  const a = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(current.blob),
    download: current.name.replace(/[^\w.-]+/g, "_") + ".jsdos",
  });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
});
$("reset-changes").addEventListener("click", async () => {
  if (!current || !confirm(`Reset saved progress for "${current.name}"? Saved games and in-game settings are removed.`)) return;
  const removed = await resetChanges("custom-" + current.id);
  status(removed ? "Saved progress removed." : "There was no saved progress.", "ok");
});
$("delete").addEventListener("click", async () => {
  if (!current || !confirm(`Delete "${current.name}" from this browser?`)) return;
  await resetChanges("custom-" + current.id);
  await storage.remove(PREFIX + current.id);
  const u = new URL(location.href);
  u.searchParams.delete("game");
  history.replaceState(null, "", u);
  params.delete("game");
  await refreshList();
  status("Game deleted.");
});

document.querySelectorAll("[data-mode]").forEach((btn) => {
  btn.addEventListener("click", async () => {
    if (!current) return;
    if (dirty) await save();
    startGame({
      gameId: "custom-" + current.id,
      blob: current.blob,
      backend: current.backend,
      mode: btn.dataset.mode,
      hints: {
        solo: "Progress saves when you click Leave or switch tabs.",
        host: "In the game, open its multiplayer menu and pick IPX network. Send the invite link to your friends.",
        join: "Once connected, open the game's multiplayer menu and pick IPX network, then join the host's game.",
      },
      onError: status,
    });
  });
});
if (params.get("join")) $("join-code").value = params.get("join");

/* -------------------------------------------------------------------- init */

initPerfHint();

refreshList().then(() => {
  if (params.get("join")) {
    status(current ? "You've been invited. Make sure the right game is selected, then click Join." : "You've been invited. Load the same game, then click Join.");
  }
}).catch((e) => {
  console.warn(e);
  status("Browser storage is unavailable (private mode?).", "err");
});
