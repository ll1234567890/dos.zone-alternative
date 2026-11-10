// Small helpers for reading and editing dosbox.conf text.
// Sections are matched case-insensitively; everything after [autoexec] is the
// startup script.

const EOL = "\r\n";
const lines = (conf) => conf.replace(/\r\n?/g, "\n").split("\n");
const join = (ls) => ls.join(EOL).replace(/(\r\n)*$/, "") + EOL;
const isHeader = (l) => /^\s*\[[^\]]+\]\s*$/.test(l);
const headerName = (l) => l.trim().slice(1, -1).trim().toLowerCase();

/** Index range [start, end) of a section's body, or null. */
function sectionRange(ls, section) {
  const start = ls.findIndex((l) => isHeader(l) && headerName(l) === section.toLowerCase());
  if (start < 0) return null;
  let end = start + 1;
  while (end < ls.length && !isHeader(ls[end])) end++;
  return [start + 1, end];
}

function keyLine(l, key) {
  const m = /^\s*([^#=\s][^=]*?)\s*=\s*(.*?)\s*$/.exec(l);
  return m && m[1].toLowerCase() === key.toLowerCase() ? m[2] : undefined;
}

export function getValue(conf, section, key) {
  const ls = lines(conf);
  const r = sectionRange(ls, section);
  if (!r) return undefined;
  for (let i = r[0]; i < r[1]; i++) {
    const v = keyLine(ls[i], key);
    if (v !== undefined) return v;
  }
  return undefined;
}

/** Set (or with value === null, remove) a key, creating the section if needed. */
export function setValue(conf, section, key, value) {
  const ls = lines(conf);
  let r = sectionRange(ls, section);
  if (!r) {
    if (value === null) return conf;
    let at = ls.findIndex((l) => isHeader(l) && headerName(l) === "autoexec");
    if (at < 0) at = ls.length;
    ls.splice(at, 0, `[${section}]`, "");
    r = [at + 1, at + 1];
  }
  for (let i = r[0]; i < r[1]; i++) {
    if (keyLine(ls[i], key) !== undefined) {
      if (value === null) ls.splice(i, 1);
      else ls[i] = `${key}=${value}`;
      return join(ls);
    }
  }
  if (value !== null) {
    // insert after the section's last non-blank line
    let at = r[1];
    while (at > r[0] && ls[at - 1].trim() === "") at--;
    ls.splice(at, 0, `${key}=${value}`);
  }
  return join(ls);
}

export function getAutoexec(conf) {
  const ls = lines(conf);
  const r = sectionRange(ls, "autoexec");
  return r ? ls.slice(r[0], r[1]).filter((l) => l.trim() !== "") : [];
}

export function setAutoexec(conf, script) {
  const ls = lines(conf);
  const r = sectionRange(ls, "autoexec");
  if (!r) return join([...ls, "", "[autoexec]", ...script]);
  ls.splice(r[0], r[1] - r[0], ...script);
  return join(ls);
}

/** A complete starting config for a DOS game. */
export function baseConf() {
  return join([
    "[sdl]",
    "autolock=false",
    "",
    "[dosbox]",
    "machine=svga_s3",
    "memsize=16",
    "",
    "[cpu]",
    "core=auto",
    "cputype=auto",
    "cycles=fixed 30000",
    "",
    "[mixer]",
    "rate=44100",
    "blocksize=1024",
    "prebuffer=20",
    "",
    "[render]",
    "frameskip=0",
    "aspect=false",
    "scaler=none",
    "",
    "[sblaster]",
    "sbtype=sb16",
    "sbbase=220",
    "irq=7",
    "dma=1",
    "hdma=5",
    "",
    "[dos]",
    "xms=true",
    "ems=true",
    "umb=true",
    "",
    "[ipx]",
    "ipx=true",
    "",
    "[autoexec]",
  ]);
}

/** Startup script: mount the bundle as C:, optional CD as D:, run a program. */
export function launchScript(program, cdImage) {
  const script = ["@echo off", "mount c ."];
  if (cdImage) script.push(`imgmount d "${cdImage}" -t iso`);
  script.push("c:");
  if (program) {
    const parts = program.split("\\");
    const exe = parts.pop();
    if (parts.length) script.push("cd \\" + parts.join("\\"));
    script.push(/\.bat$/i.test(exe) ? "call " + exe : exe);
  }
  return script;
}
