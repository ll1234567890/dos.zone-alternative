# DOS Harbor (dos.zone alternative)

A small, static, open-source site for playing DOS games you own in the browser, hosted on GitHub Pages. It works on desktop and phones.

- **Bring any DOS game:** load its folder, a `.zip` or a `.jsdos` bundle. The site picks the program to run (ranked guess over every `.EXE`/`.COM`/`.BAT`) and builds a js-dos bundle in the browser. Games are kept in IndexedDB, so you only load them once, and you can keep several.
- **Every DOSBox setting is editable:** program, CPU speed, memory, graphics and sound card, mouse lock, IPX, emulator (DOSBox or DOSBox-X), or the full `dosbox.conf`. The form and the config editor stay in sync.
- **A `.jsdos` you load is used exactly as it is**, config included. **Download .jsdos** exports any game, with your settings, as one self-contained file.
- Runs on [js-dos 8.5.3](https://js-dos.com) (DOSBox compiled to WebAssembly), vendored so everything is served from this site. Saved games persist in the browser (OPFS).
- **Online multiplayer** for games with IPX network play: one player hosts a room and shares the invite link (`…/?join=<code>`), friends join. Packets travel through **our own relay server** (`server/`). Without a relay configured, the site falls back to js-dos' WebRTC networking via `net.dos.zone`.
- **No game files are hosted here.**

## Playing online

1. Both players load the same game.
2. **Host:** click **Host room**, then **Copy invite link** and send it. In the game, open its multiplayer menu and pick the IPX network option, then create a game.
3. **Friends:** open the link, select the game and click **Join**. Once connected, pick IPX in the game and join the host's game.

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

## Multiplayer relay server

`server/` is a small Node.js WebSocket relay (one dependency: `ws`). It hands out peer IDs, stores room codes, and forwards emulated IPX packets between players. GitHub Pages only serves static files, so the relay runs somewhere else:

- **Render (free):** Dashboard → New → Blueprint → pick this repo (uses `render.yaml`). Free instances sleep when idle, so the first connection can take about a minute.
- **Anywhere with Docker:** `docker build -t dosharbor-relay server && docker run -p 8787:8787 dosharbor-relay`
- **Plain Node:** `cd server && npm ci && npm start`

Then put its URL in `site/assets/config.js`:

```js
export const RELAY_URL = "wss://dosharbor-relay.onrender.com";
```

Environment variables: `PORT` (default 8787), `ALLOWED_ORIGINS` (comma-separated list of site origins allowed to connect; empty allows all) and `GRACE_MS` (default 180000).

If a player's connection drops (hidden tab, Wi-Fi blip, sleeping laptop), the relay keeps their peer ID and room for `GRACE_MS`. The browser reconnects and resumes the same session, so the game continues: the other players see the game's own "waiting for players" screen until then (tested with Warcraft II).

To try a relay without changing the config, add `?server=wss://your-relay` to the site URL. Invite links keep it.

## Local development

```bash
npm install
npm start          # builds into _site/ and serves it on http://localhost:8080
```

## Layout

```
site/
  index.html, app.js         the app: game list, settings, play modes
  assets/player.js           storage, reading files, launching js-dos, rooms
  assets/game-screen.js      the running-game screen (leave/save, invite link)
  assets/dosconf.js          read/edit dosbox.conf keys and [autoexec]
  assets/perf-hint.js        "turn on JavaScript optimization" prompt
  assets/relay-net.js        browser client for the relay (js-dos NetInstance)
  assets/config.js           relay URL
  assets/style.css
  games/*/index.html         redirects from old addresses
scripts/build.mjs            assembles _site/ (site + vendored js-dos and fflate)
scripts/serve.mjs            tiny local static server
server/                      multiplayer relay (Node.js + ws), Dockerfile
render.yaml                  Render blueprint for the relay
```
