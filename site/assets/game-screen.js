// The game screen: switch the page from setup to the running game and handle
// leaving (with a save), invite links and the network status line.
import { launch, normalizeRoom } from "./player.js";
import { watchGameSpeed } from "./perf-hint.js";

/**
 * Switch the page to the game screen and run a bundle. Expects the shared
 * game-screen markup (#setup, #hero, #game, #game-info, #game-hint, #net-log,
 * #copy-link, #leave, #dos) and #join-code for join mode.
 * @returns {boolean} false if the mode couldn't start (e.g. no room code)
 */
export function startGame({ gameId, blob, backend, hints, mode, onError = () => {} }) {
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  let room = null;
  if (mode === "join") {
    room = normalizeRoom($("join-code").value);
    if (!room) {
      onError("Enter the room code or link from your host.", "err");
      $("join-code").focus();
      return false;
    }
  }

  $("setup").classList.add("hidden");
  $("hero")?.classList.add("hidden");
  $("game").classList.remove("hidden");
  document.body.classList.add("playing");
  setTimeout(() => document.body.classList.add("hint-seen"), 8000); // rotate hint fades out
  window.scrollTo(0, 0);

  const info = $("game-info");
  if (mode === "solo") {
    info.textContent = "Single player";
  } else if (mode === "host") {
    info.textContent = "Hosting: creating room…";
  } else {
    info.innerHTML = "";
    info.append("Joining room ", Object.assign(document.createElement("span"), { className: "room-code", textContent: room.code }));
  }
  $("game-hint").textContent = hints?.[mode] || "";

  const netLog = (msg, important) => {
    const el = $("net-log");
    el.classList.remove("hidden");
    el.classList.toggle("err", !!important);
    el.textContent = "Network: " + msg;
  };
  const inviteLink = (code) => {
    const u = new URL(location.href);
    const keep = ["game", "server"].map((k) => [k, params.get(k)]).filter(([, v]) => v);
    u.search = "";
    u.hash = "";
    u.searchParams.set("join", code);
    for (const [k, v] of keep) u.searchParams.set(k, v);
    return u.href;
  };

  const running = launch($("dos"), blob, {
    gameId,
    backend,
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

  watchGameSpeed();

  // Mouse lock is off by default, so js-dos rarely triggers its own save.
  // Save game files when leaving the game or switching away from the tab.
  const save = async () => {
    const dos = await running;
    if (!dos) return;
    await Promise.race([dos.save(), new Promise((r) => setTimeout(r, 4000))]).catch(console.warn);
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") save();
  });
  // keep ?game= and a custom relay (?server=) when leaving the game
  const back = new URLSearchParams();
  for (const k of ["game", "server"]) if (params.get(k)) back.set(k, params.get(k));
  $("leave").href = "./" + (back.toString() ? "?" + back : "");
  $("leave").addEventListener("click", async (e) => {
    e.preventDefault();
    const href = $("leave").href;
    $("leave").textContent = "Saving…";
    await save();
    location.href = href;
  });
  return true;
}
