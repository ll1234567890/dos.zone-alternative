// Shared logic for a game page: loading the player's own files, keeping them
// in the browser, the solo/host/join modes, and saving on leave.
//
// A game page provides a GAME object:
//   id, title          storage key and display name
//   exe, defaultDir    DOS games: program to find in the loaded files
//   cycles             optional fixed CPU speed applied to any bundle
//   backend            "dosbox" (default) or "dosboxX"
//   multiplayer        show host/join modes
//   hints              {solo, host, join} text shown under the game
//   dosboxConf(ctx)    builds dosbox.conf for loaded files
import {
  storage, readInput, filesFromDrop, buildBundle, launch, normalizeRoom, updateBundleConf, tuneConf, resetChanges,
} from "./player.js";

export function initGamePage(GAME) {
  const $ = (id) => document.getElementById(id);
  const status = (msg, kind = "") => {
    const el = $("status");
    el.textContent = msg;
    el.className = "status " + kind;
  };
  const params = new URLSearchParams(location.search);

  let bundle = null; // { blob, info }

  /** Latest DOSBox config for bundles we built from loose files (null for user .jsdos bundles). */
  function currentConf(info) {
    if (info?.source !== "files") return null;
    if (!info.exe) return null;
    const gameDir = info.gameDir || info.exe.split("\\")[0];
    return GAME.dosboxConf({ gameDir, exe: GAME.exe, cdImage: info.cdImage || null });
  }

  function renderFiles() {
    const ready = !!bundle;
    $("files-missing").classList.toggle("hidden", ready);
    $("files-ready").classList.toggle("hidden", !ready);
    document.querySelectorAll(".needs-files").forEach((b) => (b.disabled = !ready));
    if (ready) {
      const { info, blob } = bundle;
      const mb = (blob.size / 1048576).toFixed(1);
      const parts = [`Game files loaded (${mb} MB)`];
      if (info.exe) parts.push(`runs ${info.exe}`);
      if (info.source === "jsdos") parts.push("your own .jsdos bundle");
      else parts.push(info.cdImage ? "CD image attached" : "no CD image");
      $("ready-text").textContent = parts.join(" · ") + ".";
    }
  }

  async function ingest(files) {
    if (!files || !files.length) return;
    try {
      status("Reading files…");
      const raw = await readInput(files, (m) => status(m));
      const { bytes, info } = await buildBundle(raw, GAME, (m) => status(m));
      const blob = new Blob([bytes], { type: "application/zip" });
      status("Saving to this browser…");
      await storage.put(GAME.id, { blob, info, savedAt: Date.now() });
      bundle = { blob, info };
      renderFiles();
      status("Ready to play.", "ok");
    } catch (e) {
      console.error(e);
      status(e.message || String(e), "err");
    }
  }

  /* ---- file picking ---- */
  $("pick-zip").onclick = () => $("in-zip").click();
  $("in-zip").onchange = (e) => ingest(e.target.files);
  if ($("pick-dir")) {
    $("pick-dir").onclick = () => $("in-dir").click();
    $("in-dir").onchange = (e) => ingest(e.target.files);
  }
  $("replace").onclick = () => {
    $("files-ready").classList.add("hidden");
    $("files-missing").classList.remove("hidden");
  };
  $("reset-changes").onclick = async () => {
    if (!confirm(`Reset ${GAME.title}'s saved changes in this browser? This removes changed settings and your saved games.`)) return;
    const removed = await resetChanges(GAME.id);
    status(removed ? "Saved changes removed. The game starts with its original settings." : "There were no saved changes to remove.", "ok");
  };
  $("export")?.addEventListener("click", () => {
    if (!bundle) return;
    // the stored bundle is already one self-contained .jsdos (files + dosbox.conf)
    const a = Object.assign(document.createElement("a"), {
      href: URL.createObjectURL(bundle.blob),
      download: `${GAME.id}.jsdos`,
    });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  });
  $("forget").onclick = async () => {
    await storage.remove(GAME.id);
    bundle = null;
    renderFiles();
    status("Removed game files from this browser.");
  };

  const drop = $("drop");
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", async (e) => {
    e.preventDefault();
    drop.classList.remove("over");
    ingest(await filesFromDrop(e.dataTransfer));
  });

  /* ---- modes ---- */
  if (params.get("join") && $("join-code")) $("join-code").value = params.get("join");

  document.querySelectorAll("[data-mode]").forEach((btn) => {
    btn.addEventListener("click", () => start(btn.dataset.mode));
  });
  $("join-code")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && bundle) start("join");
  });

  function inviteLink(code) {
    const u = new URL(location.href);
    u.search = "";
    u.hash = "";
    u.searchParams.set("join", code);
    const server = params.get("server");
    if (server) u.searchParams.set("server", server);
    return u.href;
  }

  function netLog(msg, important) {
    const el = $("net-log");
    el.classList.remove("hidden");
    el.classList.toggle("err", !!important);
    el.textContent = "Network: " + msg;
  }

  function start(mode) {
    if (!bundle) return;
    let room = null;
    if (mode === "join") {
      room = normalizeRoom($("join-code").value);
      if (!room) {
        status("Enter the room code or link from your host.", "err");
        $("join-code").focus();
        return;
      }
    }

    $("setup").classList.add("hidden");
    $("hero").classList.add("hidden");
    $("game").classList.remove("hidden");

    const info = $("game-info");
    const hint = $("game-hint");
    if (mode === "solo") {
      info.textContent = "Single player";
    } else if (mode === "host") {
      info.textContent = "Hosting: creating room…";
    } else {
      info.innerHTML = "";
      info.append("Joining room ", Object.assign(document.createElement("span"), { className: "room-code", textContent: room.code }));
    }
    hint.textContent = GAME.hints?.[mode] || "";

    const running = launch($("dos"), bundle.blob, {
      gameId: GAME.id,
      backend: GAME.backend,
      mode,
      room,
      onNetLog: netLog,
      onRoom: ({ code, error }) => {
        if (error) {
          info.textContent = "Hosting (room could not be created: " + error + ")";
          return;
        }
        info.innerHTML = "";
        info.append("Hosting room ", Object.assign(document.createElement("span"), { className: "room-code", textContent: code }));
        const copy = $("copy-link");
        copy.classList.remove("hidden");
        copy.onclick = async () => {
          const link = inviteLink(code);
          try {
            await navigator.clipboard.writeText(link);
            copy.textContent = "Copied!";
          } catch {
            prompt("Copy this invite link:", link);
          }
          setTimeout(() => (copy.textContent = "Copy invite link"), 1500);
        };
      },
    }).catch((e) => {
      console.error(e);
      netLog(e.message || e, true);
    });
    keepSaved(running);
  }

  // Mouse lock is off (like dos.zone), so js-dos rarely triggers its own save.
  // Save game files when leaving the game or switching away from the tab.
  function keepSaved(running) {
    const save = async () => {
      const dos = await running;
      if (!dos) return;
      await Promise.race([dos.save(), new Promise((r) => setTimeout(r, 4000))]).catch(console.warn);
    };
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") save();
    });
    $("leave").addEventListener("click", async (e) => {
      e.preventDefault();
      const href = $("leave").href;
      $("leave").textContent = "Saving…";
      await save();
      location.href = href;
    });
  }

  // keep a custom relay (?server=) when leaving the game
  if (params.get("server")) $("leave").href = "./?server=" + encodeURIComponent(params.get("server"));

  /* ---- init ---- */
  (async () => {
    try {
      const saved = await storage.get(GAME.id);
      if (saved?.blob) {
        bundle = { blob: saved.blob, info: saved.info || {} };
        // keep stored bundles on the current config: ours, or a patched .jsdos one
        const conf = currentConf(bundle.info) || ((old) => tuneConf(old, GAME));
        const updated = await updateBundleConf(bundle.blob, conf);
        if (updated) {
          bundle.blob = updated;
          await storage.put(GAME.id, { ...saved, blob: updated });
        }
      }
    } catch (e) {
      console.warn("storage unavailable", e);
      status("Browser storage is unavailable (private mode?). You will need to load the files each visit.");
    }
    renderFiles();
    if (params.get("join")) {
      status(bundle ? "You've been invited. Click Join." : "You've been invited. Load your game files, then click Join.");
    }
  })();
}
