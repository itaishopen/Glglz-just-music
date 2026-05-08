# Galgalatz → Spotify Monitor

Monitors the [Galgalatz radio station](https://glz.co.il/גלגלץ) every 3 minutes, detects the currently-playing song ("מתנגן כעת"), searches for it on Spotify, and adds it to a playlist — keeping only the last 100 tracks.

---

## Table of Contents

1. [Architecture](#architecture)
2. [Folder structure](#folder-structure)
3. [Prerequisites](#prerequisites)
4. [Spotify setup](#spotify-setup)
5. [Raspberry Pi installation](#raspberry-pi-installation)
6. [Running manually](#running-manually)
7. [Running as a systemd service](#running-as-a-systemd-service)
8. [Testing the script](#testing-the-script)
9. [Troubleshooting](#troubleshooting)
10. [How to update the page selector](#how-to-update-the-page-selector)

---

## Architecture

```
Every 3 minutes:
  ┌──────────────────────────────────────────────────────────────┐
  │                      src/index.js (main loop)                 │
  └──────┬──────────────────────────────────────────┬────────────┘
         │                                          │
  ┌──────▼──────┐                        ┌──────────▼───────────┐
  │ src/scraper │  Playwright+Chromium   │   src/spotify.js      │
  │    .js      │  loads glz.co.il,      │   axios HTTP client   │
  │             │  extracts the song     │   refresh token auth  │
  └──────┬──────┘  after JS renders      └──────────┬───────────┘
         │                                          │
         │  "Wu Lyf - Love Your Fate"               │ search / add / trim
         │                                          │
  ┌──────▼──────────────────────────────────────────▼───────────┐
  │                     src/state.js                             │
  │              data/state.json  (survives restarts)            │
  └──────────────────────────────────────────────────────────────┘
```

**Scraper strategies** (tried in order — first success wins):
1. `page.innerText` line extraction — waits up to 20 s for JS to render the "מתנגן כעת" text, then grabs the whole line.
2. DOM `TreeWalker` — walks all text nodes and collects the parent element text, useful when label and title are in separate `<span>`s.
3. Full `textContent` split — raw fallback if the first two fail.

**Spotify matching logic:**
- If the raw string contains ` - `, it is split into `artist` and `title`.
- Primary search: `<title> artist:<artist>` — Spotify's field filter gives precise results.
- Fallback: plain keyword query if the field-filtered search returns nothing.
- Among up to 5 candidates, each track is scored on title similarity (0–10), artist similarity (0–8), and popularity (0–5). The highest scorer wins.

---

## Folder structure

```
glglz-just-music/
├── src/
│   ├── index.js        Main loop — orchestrates everything
│   ├── scraper.js      Playwright-based page scraper
│   ├── spotify.js      Spotify API client (auth, search, playlist)
│   ├── state.js        Read/write data/state.json
│   ├── config.js       Validates and exports all env vars
│   └── logger.js       Winston logger (console + optional file)
├── scripts/
│   ├── get-token.js    One-time helper to obtain a Spotify refresh token
│   └── inspect-page.js Debug helper — screenshots the page and dumps DOM
├── data/
│   └── state.json      Auto-created; tracks the last-played song
├── .env.example        Template — copy to .env and fill in secrets
├── .gitignore
├── package.json
├── glglz-monitor.service  systemd unit file
└── README.md
```

---

## Prerequisites

- **Raspberry Pi** running Raspberry Pi OS Bookworm (64-bit recommended — Pi 4 or Pi 5)
- **Node.js 18+**
- **Chromium** (installed separately on Pi 3; bundled on Pi 4/5 via Playwright)
- A **Spotify account** (free or premium) and a Developer App

---

## Spotify setup

### 1. Create a Developer App

1. Go to [https://developer.spotify.com/dashboard](https://developer.spotify.com/dashboard) and log in.
2. Click **Create app**.
3. Fill in any name and description.
4. Under **Redirect URIs** add exactly: `http://localhost:8888/callback`
5. Check **Web API** under APIs used.
6. Save. You'll land on a page showing your **Client ID** and **Client Secret**.

### 2. Create a playlist

1. In Spotify, create a new playlist (name it anything, e.g. "Galgalatz Now Playing").
2. Copy its URL from the share menu. It looks like:
   `https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M`
3. The **Playlist ID** is the last path segment: `37i9dQZF1DXcBWIGoYBM5M`

### 3. Create your `.env` file

```bash
cd ~/glglz-just-music
cp .env.example .env
nano .env
```

Fill in `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, and `SPOTIFY_PLAYLIST_ID`.

### 4. Get a refresh token

Run the token helper **on a machine that has a browser** (your laptop is fine —
you can copy the resulting `SPOTIFY_REFRESH_TOKEN` to the Pi afterwards):

```bash
# On your laptop (must have Node 18+ installed):
node scripts/get-token.js
```

The script starts a temporary local server on port 8888, opens the Spotify auth
page, and captures the callback automatically.

1. Open the printed URL in a browser.
2. Click "Agree". Spotify will redirect back to `localhost:8888/callback`.
3. The script captures the code and prints your token — no copy-paste needed.
4. Copy the `SPOTIFY_REFRESH_TOKEN=...` line into your `.env` file on the Pi.

> **Required scopes** (already configured in `get-token.js`):
> `playlist-modify-public`, `playlist-modify-private`, `playlist-read-private`,
> `playlist-read-collaborative`

---

## Raspberry Pi installation

### 1. Update the system

```bash
sudo apt update && sudo apt upgrade -y
```

### 2. Install Node.js 20

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node --version   # should print v20.x.x
```

### 3. Install Chromium

**Raspberry Pi 4 / 5 (ARM64):**
Playwright will download its own Chromium; skip this step.

**Raspberry Pi 3 (ARM32):**
Playwright's bundled Chromium is ARM64-only. Install the system one instead:

```bash
sudo apt install -y chromium-browser
# Tell the script where to find it:
echo "CHROMIUM_PATH=/usr/bin/chromium-browser" >> .env
```

### 4. Clone the repo

```bash
cd ~
git clone https://github.com/itaishopen/glglz-just-music.git
cd glglz-just-music
```

### 5. Install Node dependencies

```bash
npm install
```

### 6. Install Playwright's Chromium (Pi 4 / 5 only)

```bash
npx playwright install chromium
# Install OS-level dependencies that Chromium needs:
npx playwright install-deps chromium
```

### 7. Configure environment

```bash
cp .env.example .env
nano .env   # fill in all four Spotify values
```

---

## Running manually

```bash
# From the project directory:
node src/index.js
```

You should see output like:

```
[2024-05-01 14:00:00] INFO: ════ Galgalatz → Spotify Monitor  (starting up) ════
[2024-05-01 14:00:00] INFO: ─── Checking now-playing ───
[2024-05-01 14:00:04] INFO: Now playing: "Wu Lyf - Love Your Fate"
[2024-05-01 14:00:04] INFO: New song detected (was: "none")
[2024-05-01 14:00:05] INFO: Found on Spotify: "Love Your Fate" by Wu Lyf (popularity: 42)
[2024-05-01 14:00:06] INFO: ✓ Added to playlist: "Love Your Fate" by Wu Lyf
[2024-05-01 14:00:06] INFO: State updated ✓
```

Stop with `Ctrl-C`. The last-played song is saved in `data/state.json` so restarting does not re-add the same song.

---

## Running as a systemd service

### Install the service

```bash
# Edit WorkingDirectory and User in the service file if needed
sudo cp glglz-monitor.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable glglz-monitor
sudo systemctl start glglz-monitor
```

### Check status and logs

```bash
sudo systemctl status glglz-monitor
journalctl -u glglz-monitor -f          # live log tail
journalctl -u glglz-monitor --since "1 hour ago"
```

### Stop / restart

```bash
sudo systemctl stop glglz-monitor
sudo systemctl restart glglz-monitor
```

---

## Testing the script

### Test scraper only

```bash
node -e "
  require('dotenv').config();
  const s = require('./src/scraper');
  s.getNowPlaying().then(song => console.log('Song:', song)).catch(console.error);
"
```

### Test Spotify search only

```bash
node -e "
  require('dotenv').config();
  const sp = require('./src/spotify');
  sp.searchTrack('Wu Lyf - Love Your Fate').then(t => console.log(t)).catch(console.error);
"
```

### Test adding to playlist

```bash
node -e "
  require('dotenv').config();
  const sp = require('./src/spotify');
  sp.searchTrack('Wu Lyf - Love Your Fate')
    .then(t => t ? sp.addTrackToPlaylist(t.uri) : Promise.reject('not found'))
    .then(() => console.log('Added!'))
    .catch(console.error);
"
```

### Run the page inspector

When you want to see what the page looks like and whether the scraper can find the text:

```bash
npm run inspect
# Creates: data/inspect-screenshot.png  (open this in any image viewer)
#          data/inspect-body.txt         (full page text)
```

---

## Troubleshooting

### "No Chromium found"

- **Pi 4/5:** run `npx playwright install chromium && npx playwright install-deps chromium`
- **Pi 3:** install system Chromium and set `CHROMIUM_PATH=/usr/bin/chromium-browser` in `.env`

### "מתנגן כעת not found on page"

The site may have changed its DOM. Run the inspector:

```bash
npm run inspect
```

Open `data/inspect-screenshot.png` to see the page visually.
Check `data/inspect-body.txt` and search for the now-playing text.
See [How to update the page selector](#how-to-update-the-page-selector) below.

### "No Spotify result for …"

The song name from the radio may include extra characters (e.g. a remix label in
Hebrew). Set `LOG_LEVEL=debug` in `.env` to see exactly what query is sent, and
check manually on open.spotify.com to see how the track is listed.

### "ENOMEM" / Chromium crashes on Pi

Add `--single-process` to the args list in `src/scraper.js`. Also ensure you
have at least 512 MB of RAM free. On Pi 3, increase the swap:

```bash
sudo dphys-swapfile swapoff
sudo sed -i 's/CONF_SWAPSIZE=100/CONF_SWAPSIZE=512/' /etc/dphys-swapfile
sudo dphys-swapfile setup && sudo dphys-swapfile swapon
```

### Spotify returns 401

Your access token or refresh token is invalid. Re-run `node scripts/get-token.js`
and update `SPOTIFY_REFRESH_TOKEN` in `.env`.

### Spotify returns 403

The app does not have the correct scopes. Re-run `node scripts/get-token.js` to
re-authorise (it includes all required scopes).

### systemd service keeps restarting

```bash
journalctl -u glglz-monitor -n 50 --no-pager
```

Look for the startup error. Common causes:
- `.env` file not found or missing a variable
- `node` not in `/usr/bin/node` — check with `which node` and update `ExecStart` in the service file

---

## How to update the page selector

If the website is redesigned and the scraper stops working:

1. Run `npm run inspect` — this saves a screenshot and the full DOM text.
2. Open `data/inspect-body.txt` and search for the text near the currently-playing song.
3. Open `data/inspect-screenshot.png` to see the visual layout.
4. In your browser DevTools (`F12`), navigate to the page, right-click the
   "מתנגן כעת" text and select "Inspect".
5. Note the element's class or attribute (e.g. `class="now-playing-title"`).
6. Update `extractNowPlaying()` in `src/scraper.js` to use that selector:

```js
// Example: if the title is in <span class="now-playing-title">
const song = await page.locator('.now-playing-title').textContent();
```

The three-strategy fallback in the scraper is designed to survive minor DOM
changes without any code edit. A full redesign may require updating the code
as shown above.
