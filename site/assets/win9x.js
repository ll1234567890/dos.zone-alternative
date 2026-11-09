// DOSBox-X settings for Windows 95/98 games booted from the player's own disk
// image. The machine settings follow dos.zone's Age of Empires bundle
// (cdn.dos.zone/custom/dos/aoe-nic.jsdos); the disks are local files instead
// of dos.zone's streamed drives.

/** @param {{disks: string[], cdImage: string|null, title?: string}} ctx */
export function win9xConf({ disks, cdImage, title = "Windows 9x" }) {
  const dos = (p) => p.replace(/\//g, "\\");
  return [
    "[sdl]",
    "autolock=false",
    "mouse_emulation=integration",
    "",
    "[dosbox]",
    `title=${title}`,
    "memsize=128",
    "",
    "[video]",
    "vmemsize=8",
    "vesa modelist width limit=0",
    "vesa modelist height limit=0",
    "",
    "[dos]",
    "ver=7.1",
    "hard drive data rate limit=0",
    "floppy drive data rate limit=0",
    "",
    "[cpu]",
    "cputype=pentium", // dos.zone uses pentium_mmx; this DOSBox-X build falls back to pentium
    "core=auto",
    "integration device=true",
    "",
    "[sblaster]",
    "sbtype=sb16vibra",
    "",
    "[fdc, primary]",
    "int13fakev86io=true",
    "",
    "[ide, primary]",
    "int13fakeio=true",
    "int13fakev86io=true",
    "",
    "[ide, secondary]",
    "int13fakeio=true",
    "int13fakev86io=true",
    "cd-rom insertion delay=4000",
    "",
    "[render]",
    "scaler=none",
    "",
    "[autoexec]",
    // BIOS hard disks 2 and 3 are C: and D: for the booted Windows
    ...disks.map((d, i) => `imgmount ${i + 2} "${dos(d)}" -t hdd`),
    ...(cdImage ? [`imgmount e "${dos(cdImage)}" -t iso`] : []),
    "boot c:",
  ].join("\r\n") + "\r\n";
}
