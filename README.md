# DOS Harbor (dos.zone alternative)

A small, static, open-source site for playing DOS games in the browser, hosted on GitHub Pages.
It currently has one game: **Warcraft II: Tides of Darkness**, playable solo or **online with friends**.

- Runs on [js-dos 8.5.3](https://js-dos.com) (DOSBox compiled to WebAssembly). The player is vendored, so everything is served from this site.
- **Multiplayer:** js-dos emulates IPX over WebRTC. The host gets a short room code and an invite link (`…/games/warcraft2/?join=<code>`). Joiners connect peer-to-peer. Rooms are registered as aliases on the public js-dos peer server (`net.dos.zone`).
- **No game files are hosted here.** Each player loads their own copy of the DOS version (a folder or `.zip` that contains `WAR2.EXE`, or a ready-made `.jsdos` bundle). The site turns it into a js-dos bundle in the browser and keeps it in IndexedDB, so you only load it once. Saved games persist in the browser (OPFS).
- An optional CD image (`.cue`/`.bin` or `.iso`) next to the game is mounted as `D:` for CD music and cutscenes.

## Playing online (Warcraft II)

1. **Host:** open the Warcraft II page, click **Host room**, then **Copy invite link** and send it to your friends.
   In the game, choose *Multi Player Game → IPX Network → Create Game*.
2. **Friends:** open the link and click **Join**. Once connected, choose *Multi Player Game → IPX Network* and pick the host's game.

Everyone needs their own copy, ideally the same version.

## Deploying to GitHub Pages

The workflow in `.github/workflows/pages.yml` builds and deploys on every push to `main`.

One-time setup: **Settings → Pages → Build and deployment → Source: GitHub Actions**.

The site will be available at `https://<user>.github.io/dos.zone-alternative/`.

### Fallback: deploy without Actions

If Actions can't run, push a prebuilt copy to the `gh-pages` branch:

```bash
npm install
npm run deploy:branch
```

Then set **Settings → Pages → Source: Deploy from a branch → `gh-pages` / (root)**.

## Local development

```bash
npm install
npm start          # builds into _site/ and serves it on http://localhost:8080
```

## Layout

```
site/
  index.html                 game library
  assets/games.js            catalog (add new games here)
  assets/player.js           shared logic: bundle building, storage, launching, rooms
  assets/style.css
  games/warcraft2/           Warcraft II page and its DOSBox config
scripts/build.mjs            assembles _site/ (site + vendored js-dos and fflate)
scripts/serve.mjs            tiny local static server
```

### Adding another game

1. Add an entry to `site/assets/games.js`.
2. Copy `site/games/warcraft2/` to `site/games/<id>/` and change the `GAME` object in `game.js`: the executable name, folder name and `dosboxConf`.

## Legal

This project does not distribute any copyrighted game data. Warcraft is a trademark of Blizzard Entertainment.
This site is not affiliated with Blizzard, dos.zone or js-dos. js-dos is GPL-2.0 licensed.
