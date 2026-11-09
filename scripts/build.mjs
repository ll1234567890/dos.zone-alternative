// Assemble the static site into _site/ for GitHub Pages.
//  - copies site/ as-is
//  - vendors js-dos (player + emulator wasm) into _site/vendor/js-dos/
//  - vendors fflate (zip library) into _site/vendor/fflate.js
// Everything is served from the same origin, so web workers and wasm load
// without any cross-origin trouble.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "_site");
const mod = (p) => join(root, "node_modules", p);

if (!existsSync(mod("js-dos/dist/js-dos.js"))) {
  console.error("node_modules missing - run `npm install` first.");
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

cpSync(join(root, "site"), out, { recursive: true });

const jsdosOut = join(out, "vendor", "js-dos");
mkdirSync(jsdosOut, { recursive: true });
cpSync(mod("js-dos/dist/js-dos.css"), join(jsdosOut, "js-dos.css"));

// js-dos 8.5 always plays sound through an AudioWorklet that time-stretches
// audio (tempo 0.95-1.05) to track its buffer level, which makes sustained
// notes such as FM music warble. Make it opt-in: the page sets
// window.__dosharborAudioWorklet = true only for ?audio=worklet. Otherwise
// js-dos uses its plain player at DOSBox's own sample rate.
const PATCH_FROM = "audioWorklet:!0";
const PATCH_TO = "audioWorklet:window.__dosharborAudioWorklet===true";
const jsdos = readFileSync(mod("js-dos/dist/js-dos.js"), "utf8");
if (jsdos.split(PATCH_FROM).length !== 2) {
  console.error(`js-dos.js: expected exactly one "${PATCH_FROM}" - js-dos changed, update the audio patch.`);
  process.exit(1);
}
writeFileSync(join(jsdosOut, "js-dos.js"), jsdos.replace(PATCH_FROM, PATCH_TO));
cpSync(mod("js-dos/dist/emulators"), join(jsdosOut, "emulators"), {
  recursive: true,
  // types and source maps are not needed at runtime
  filter: (src) => !src.includes(`${"emulators"}/types`) && !src.endsWith(".map"),
});

cpSync(mod("fflate/umd/index.js"), join(out, "vendor", "fflate.js"));

// Serve files verbatim (no Jekyll processing on GitHub Pages).
writeFileSync(join(out, ".nojekyll"), "");

console.log("Built site into", out);
