// Prompt players to enable the browser's JavaScript optimizer.
//
// Chrome ("JavaScript optimization & security"), Edge ("Enhance your security
// on the web") and other Chromium browsers can turn off V8's optimizing
// compiler per site, which makes the emulator several times slower; the
// strictest modes remove WebAssembly entirely, so js-dos can't run at all.
//
// Detection: a hot JS loop is timed against a native built-in (typed-array
// sort) that runs at the same speed with or without the optimizer, which
// cancels out how fast the device is. Measured in Chromium: ratio ~0.2 with
// the optimizer, ~0.9 without (same with 4x CPU throttling), 1.1+ interpreter
// only. Only Chromium browsers have this setting, so others aren't probed.

const DISMISS_KEY = "dosharbor-optimizer-hint-dismissed";
const RATIO_LIMIT = 0.5;

function browser() {
  const ua = navigator.userAgent;
  const brands = (navigator.userAgentData?.brands || []).map((b) => b.brand).join(" ");
  if (/Edg\//.test(ua) || /Microsoft Edge/.test(brands)) return "edge";
  if (/OPR\//.test(ua) || /Opera/.test(brands)) return "opera";
  if (navigator.brave || /Brave/.test(brands)) return "brave";
  if (/Chrome\//.test(ua) || /Chromium|Google Chrome/.test(brands)) return "chrome";
  return "other";
}

/** @returns {"nowasm"|"off"|"ok"|"unknown"} */
export function checkJsOptimizer() {
  if (typeof WebAssembly !== "object") return "nowasm";
  if (browser() === "other") return "unknown";
  function work(n) {
    let a = 0, b = 1;
    for (let i = 0; i < n; i++) { a = (a + b * i) | 0; b = (b ^ (a >>> 3)) | 0; }
    return a + b;
  }
  const arr = new Float64Array(200000);
  const native = () => {
    for (let i = 0; i < arr.length; i++) arr[i] = (i * 2654435761) % 1000003;
    const t = performance.now();
    arr.sort();
    return performance.now() - t;
  };
  work(2e5); work(2e5); native(); // warm up so the optimizer can kick in
  const ratios = [];
  for (let r = 0; r < 3; r++) {
    const n = native();
    const t = performance.now();
    work(7e5);
    ratios.push((performance.now() - t) / Math.max(n, 0.01));
  }
  ratios.sort((x, y) => x - y);
  return ratios[1] > RATIO_LIMIT ? "off" : "ok";
}

const dismissed = () => { try { return localStorage.getItem(DISMISS_KEY) === "1"; } catch { return false; } };
const dismiss = () => { try { localStorage.setItem(DISMISS_KEY, "1"); } catch { /* private mode */ } };

function steps(site) {
  const b = browser();
  const scheme = { chrome: "chrome", brave: "brave", opera: "opera" }[b];
  if (b === "edge") {
    return {
      url: "edge://settings/privacy",
      list: [
        "Open Edge settings: copy the address below into a new tab.",
        "Under <strong>Security</strong>, find <strong>Enhance your security on the web</strong>.",
        `Click <strong>Exceptions</strong> (or <em>Manage exceptions</em>), add <code>${site}</code>, or set the mode to <em>Balanced</em>.`,
        "Come back and reload this page.",
      ],
    };
  }
  if (scheme) {
    return {
      url: `${scheme}://settings/content/v8`,
      list: [
        "Open the setting: copy the address below into a new tab.",
        "Choose <strong>Sites can use the JavaScript optimizer</strong>, or under <em>Allowed to use the JavaScript optimizer</em> click <strong>Add</strong> and enter " + `<code>${site}</code>.`,
        "Come back and reload this page.",
      ],
    };
  }
  return {
    url: "",
    list: [
      "Check your browser's privacy or security settings for an option that disables the JavaScript JIT or optimizer (sometimes called a hardened or locked-down mode), and allow it for this site.",
      "Reload this page.",
    ],
  };
}

let shown = false;

/** Show the prompt at the top of <main>. reason: "off" | "nowasm" | "slow" */
export function showOptimizerPrompt(reason) {
  if (shown || (reason !== "nowasm" && dismissed())) return;
  shown = true;
  const site = location.origin;
  const s = steps(site);
  const title = {
    nowasm: "Your browser has WebAssembly turned off, so games can't run",
    off: "Turn on JavaScript optimization for much better game speed",
    slow: "The game is running below full speed",
  }[reason];
  const intro = {
    nowasm: "A strict security setting (often “Enhance your security on the web” in Edge, or JavaScript optimization being blocked in Chrome) disables WebAssembly, which the emulator needs.",
    off: "Your browser's JavaScript optimizer is off for this site, which makes the emulator several times slower. In Chrome it's called <strong>JavaScript optimization &amp; security</strong>; in Edge, <strong>Enhance your security on the web</strong>.",
    slow: "If your browser's JavaScript optimizer is off for this site (Chrome: <strong>JavaScript optimization &amp; security</strong>; Edge: <strong>Enhance your security on the web</strong>), turning it on usually fixes this. Lowering the game's CPU speed can help too.",
  }[reason];

  const box = document.createElement("section");
  box.className = "perf-hint" + (reason === "nowasm" ? " severe" : "");
  box.setAttribute("role", "alert");
  box.innerHTML = `
    <div class="perf-hint-head">
      <h2></h2>
      <button class="dh-btn small" type="button" data-close aria-label="Dismiss">Dismiss</button>
    </div>
    <p class="perf-intro"></p>
    <ol></ol>
    <div class="row perf-url hidden">
      <code class="perf-addr"></code>
      <button class="dh-btn small" type="button" data-copy>Copy address</button>
    </div>
    <label class="perf-never"><input type="checkbox"> Don't show this again</label>`;
  box.querySelector("h2").textContent = title;
  box.querySelector(".perf-intro").innerHTML = intro;
  box.querySelector("ol").innerHTML = s.list.map((li) => `<li>${li}</li>`).join("");
  if (s.url) {
    box.querySelector(".perf-url").classList.remove("hidden");
    box.querySelector(".perf-addr").textContent = s.url;
    box.querySelector("[data-copy]").onclick = async (e) => {
      try {
        await navigator.clipboard.writeText(s.url);
        e.target.textContent = "Copied!";
      } catch {
        prompt("Copy this address into a new tab:", s.url);
      }
    };
  }
  if (reason === "nowasm") box.querySelector(".perf-never").remove();
  box.querySelector("[data-close]").onclick = () => {
    if (box.querySelector(".perf-never input")?.checked) dismiss();
    box.remove();
  };
  const main = document.querySelector("main");
  main.insertBefore(box, main.firstChild);
}

/** Run the optimizer check once the page is idle. */
export function initPerfHint() {
  const run = () => {
    try {
      const result = checkJsOptimizer();
      if (result === "off" || result === "nowasm") showOptimizerPrompt(result);
    } catch (e) {
      console.warn("optimizer check failed", e);
    }
  };
  if ("requestIdleCallback" in window) requestIdleCallback(run, { timeout: 3000 });
  else setTimeout(run, 500);
}

/**
 * While a game runs, watch js-dos' speed readout (the % under TURBO) and
 * show the prompt if it stays below 85% after the game has had time to boot.
 */
export function watchGameSpeed() {
  let low = 0;
  const started = Date.now();
  const timer = setInterval(() => {
    if (shown) return clearInterval(timer);
    if (Date.now() - started < 25000 || document.hidden) return;
    const m = /(\d+)%/.exec(document.querySelector(".sidebar")?.innerText || "");
    if (!m) return;
    low = Number(m[1]) < 85 ? low + 1 : 0;
    if (low >= 6) {
      clearInterval(timer);
      showOptimizerPrompt("slow");
    }
  }, 2000);
}
