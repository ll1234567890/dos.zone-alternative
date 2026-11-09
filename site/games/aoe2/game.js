import { initGamePage } from "../../assets/game-page.js";
import { win9xConf } from "../../assets/win9x.js";

initGamePage({
  id: "aoe2",
  title: "Age of Empires II",
  kind: "win9x",
  backend: "dosboxX",
  multiplayer: false,
  hints: {
    solo: "Windows is booting from your disk image. Before clicking Leave, shut Windows down (Start → Shut Down) so your saves are written safely.",
  },
  dosboxConf: (ctx) => win9xConf({ ...ctx, title: "Age of Empires II" }),
});
