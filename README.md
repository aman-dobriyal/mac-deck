# 🎛️ Mac Deck

Control your Mac from any phone browser. Built as a PWA — install it from Chrome and it opens fullscreen like a native app, no browser bar, no App Store.

Works over **WiFi** or **USB** (ADB). Tested on OnePlus 12 → Mac (clamshell mode).

---

## What it does

| Control | What happens |
|---------|-------------|
| ⏮ ⏸ ⏭ | Play / pause / skip — works with YouTube, Spotify, Apple Music, Twitch, anything |
| 🔊 Volume | System volume slider + step buttons + mute toggle |
| 🌑 Dim | AMOLED screen dimmer to save battery while docked |
| App grid | Tap any running app to instantly switch to it (Chrome shows per-window/profile) |
| Wake | Nudge Mac display awake (`caffeinate -u -t 1`) |
| Lock | Lock screen |
| Mission | Open Mission Control |
| Screenshot | Interactive screenshot → saved to Desktop |
| Sleep | Put Mac to sleep |
| Wake on LAN | Copy or run the `wakeonlan` magic-packet command in Termux |

**Extras**
- Phone screen stays on (Wake Lock API)
- Mac stays awake while phone is connected (caffeinate)
- Auto-reloads the UI when the server restarts
- Installs as a PWA (fullscreen, no browser chrome)

---

## Requirements

- macOS (Apple Silicon or Intel)
- Node.js — install via [Homebrew](https://brew.sh): `brew install node`
- A phone with Chrome

Optional but recommended:
```bash
brew install nowplaying-cli   # richer Now Playing info (title + artist)
brew install wakeonlan        # needed for Wake on LAN from Termux
```

---

## Setup

### 1 — Clone & install

```bash
git clone https://github.com/aman-dobriyal/mac-deck.git
cd mac-deck
npm install
```

### 2 — Start the server (manual, one-off)

```bash
node server.js
```

You'll see:
```
🎛️  Mac Deck running!

   WiFi  →  http://192.168.x.x:3333
   USB   →  http://localhost:3333   (adb reverse tcp:3333 tcp:3333)
```

Open that URL in Chrome on your phone and you're good to go.

### 3 — Run as a background service (auto-starts at login)

This is the recommended way — the server runs forever in the background, survives restarts, and starts automatically when you log into your Mac.

```bash
# 1. Build the app bundle (one-time)
mkdir -p ~/Applications/MacDeck.app/Contents/{MacOS,Resources}

# Copy Info.plist, icon, and launcher from this repo
cp extras/MacDeck.app/Contents/Info.plist      ~/Applications/MacDeck.app/Contents/Info.plist
cp extras/MacDeck.app/Contents/MacOS/MacDeck   ~/Applications/MacDeck.app/Contents/MacOS/MacDeck
cp extras/MacDeck.app/Contents/Resources/AppIcon.icns ~/Applications/MacDeck.app/Contents/Resources/AppIcon.icns
chmod +x ~/Applications/MacDeck.app/Contents/MacOS/MacDeck

# Edit the launcher script so paths point to where you cloned the repo
nano ~/Applications/MacDeck.app/Contents/MacOS/MacDeck

# 2. Install the launchd agent
cp extras/com.macdeck.server.plist ~/Library/LaunchAgents/com.macdeck.server.plist

# Edit it to match your username / clone path
nano ~/Library/LaunchAgents/com.macdeck.server.plist

# 3. Load it
launchctl load ~/Library/LaunchAgents/com.macdeck.server.plist
```

> **Note:** The `extras/` folder in this repo contains ready-to-use templates for the app bundle and plist. Edit the paths inside them to match where you cloned the repo.

---

## Connect your phone

### WiFi (easiest)
Open Chrome on your phone → go to the **WiFi URL** shown in the terminal → done.

### USB / ADB (most reliable — enables full PWA install)
USB gives you `localhost` which Chrome treats as secure, so the PWA install prompt appears automatically.

```bash
# Enable Wireless Debugging on your phone (Developer Options → Wireless Debugging)
# Pair once:
adb pair <phone-ip>:<pair-port> <6-digit-code>

# Then connect:
adb connect <phone-ip>:<connect-port>

# Forward the port so localhost on the phone hits the Mac:
adb reverse tcp:3333 tcp:3333

# Open http://localhost:3333 in Chrome on the phone
```

---

## Install as a PWA

### Via USB / localhost
Chrome shows an **"Add to Home Screen"** banner at the top automatically. Tap it → the app appears in your launcher → opens fullscreen.

### Via WiFi
Chrome menu (⋮) → **Add to Home Screen** → done. Opens in standalone mode (no address bar).

### Already in standalone / fullscreen mode?
There's a ⛶ button in the top-right corner to toggle fullscreen manually.

---

## Stop the server

### If you started it manually (`node server.js`)
Press `Ctrl + C` in the terminal where it's running.

Or kill it by port:
```bash
lsof -ti :3333 | xargs kill
```

### If it's running as a background service (launchd)
```bash
# Stop it now (won't restart until you load it again or reboot):
launchctl unload ~/Library/LaunchAgents/com.macdeck.server.plist

# Start it again:
launchctl load ~/Library/LaunchAgents/com.macdeck.server.plist

# Check if it's running and get the PID:
launchctl list com.macdeck.app

# View live logs:
tail -f /tmp/macdeck.log

# Kill the process directly (launchd will auto-restart it within ~10 s):
lsof -ti :3333 | xargs kill
```

### Remove the service entirely
```bash
launchctl unload ~/Library/LaunchAgents/com.macdeck.server.plist
rm ~/Library/LaunchAgents/com.macdeck.server.plist
```

---

## Change the port

Edit `server.js`, line 10:
```js
const PORT = 3333;   // ← change this
```

Then restart the server. If using ADB, update the `adb reverse` command to match.

---

## Customise the app grid

The app grid is built dynamically from whatever is actually running on your Mac — no config needed. Chrome is smart enough to show one tile per open window/profile so you can switch between them individually.

If you want to filter out certain apps, edit the `HIDDEN_PROCS` set near the top of `server.js`:
```js
const HIDDEN_PROCS = new Set([
  'loginwindow', 'Dock', 'SystemUIServer', /* add more here */
]);
```

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Server won't start — port in use | `lsof -ti :3333 \| xargs kill` then restart |
| Media buttons do nothing | Install `nowplaying-cli` via brew, or make sure something is actually playing |
| App shows old UI after update | Hard-refresh: hold Shift and tap the browser refresh, or clear site data |
| Can't install as PWA over WiFi | Use USB + `adb reverse` so you get `localhost` |
| Mac asks for Accessibility permission | Allow Terminal / Node in System Settings → Privacy → Accessibility |
| "Mac Deck" not showing in System Settings | Open `~/Applications/MacDeck.app` once manually so macOS registers it |
| launchd service not starting | Check `/tmp/macdeck.err` for the error |
| ADB pairing keeps failing | Pairing codes expire in ~60 s — generate a fresh one and paste it quickly |

---

## Project layout

```
mac-deck/
├── server.js          ← Node.js server (WebSocket + HTTP + all Mac control logic)
├── package.json
├── public/
│   ├── index.html     ← The entire PWA UI (single file, no build step)
│   ├── sw.js          ← Service worker (cache strategy)
│   ├── manifest.json  ← PWA manifest (name, icons, display mode)
│   ├── icon.svg
│   └── icon-maskable.svg
└── extras/            ← Templates for the background service setup
    ├── com.macdeck.server.plist
    └── MacDeck.app/
        └── Contents/
            ├── Info.plist
            ├── MacOS/MacDeck
            └── Resources/AppIcon.icns
```

---

## How it works

- **Server** — plain Node.js HTTP + WebSocket server (no framework). Serves `public/` as static files and handles real-time control messages over WebSocket.
- **Mac control** — uses `osascript` (AppleScript / JXA) for volume, app switching, sleep, lock, mission control, and screenshot. Media keys are simulated with real `NSEvent` / `CGEventPost` calls so they work with any app (YouTube, Twitch, Spotify web, etc.).
- **Icons** — extracted live from the running app's `.app` bundle using `sips` (built-in macOS), converted to PNG and served over HTTP.
- **PWA** — `manifest.json` with `"display": "fullscreen"`, a service worker for offline shell, and Wake Lock API to keep the phone screen on.
- **Background service** — a `launchd` agent wrapping the Node process in a minimal `.app` bundle so macOS attributes permission prompts to "Mac Deck" instead of Terminal.

---

## License

MIT — do whatever you want with it.
