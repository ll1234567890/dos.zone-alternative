// Assemble the static site into _site/ for GitHub Pages.
//  - copies site/ as-is
//  - vendors js-dos (player + emulator wasm) into _site/vendor/js-dos/
//  - vendors fflate (zip library) into _site/vendor/fflate.js
// Everything is served from the same origin, so web workers and wasm load
// without any cross-origin trouble.
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
for (const f of ["js-dos.js", "js-dos.css"]) {
  cpSync(mod(`js-dos/dist/${f}`), join(jsdosOut, f));
}
cpSync(mod("js-dos/dist/emulators"), join(jsdosOut, "emulators"), {
  recursive: true,
  // types and source maps are not needed at runtime
  filter: (src) => !src.includes(`${"emulators"}/types`) && !src.endsWith(".map"),
});

cpSync(mod("fflate/umd/index.js"), join(out, "vendor", "fflate.js"));

// Serve files verbatim (no Jekyll processing on GitHub Pages).
writeFileSync(join(out, ".nojekyll"), "");

console.log("Built site into", out);
