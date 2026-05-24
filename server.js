'use strict';

// Never let a single unhandled rejection crash the whole server
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection (non-fatal):', err?.message || err);
});

const http      = require('http');
const WebSocket = require('ws');
const { exec }  = require('child_process');
const fs        = require('fs');
const path      = require('path');
const os        = require('os');

const PORT           = 3333;
const PUBLIC_DIR     = path.join(__dirname, 'public');
const MAC_ADDRESS    = '10:b5:88:64:cf:e3';
const SERVER_VERSION = Date.now().toString();

const HIDDEN_PROCS = new Set([
  'loginwindow', 'Dock', 'SystemUIServer', 'WindowServer',
  'ControlStrip', 'Control Centre', 'Notification Centre',
  'Spotlight', 'TextInputMenuAgent', 'AirPlayUIAgent',
  'WiFiAgent', 'universalaccessd', 'talagent', 'app_mode_loader',
]);

// ─── Helpers ──────────────────────────────────────────────────────────────────
function run(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: 5000 }, (err, stdout) =>
      err ? reject(err) : resolve(stdout.trim())
    );
  });
}

// ─── JXA media-key simulation ─────────────────────────────────────────────────
// Sends the real system media key event — works with ANY app (Chrome, YouTube,
// Spotify web, Twitch, etc.) without requiring any external tools.
// NX key codes: 16 = Play/Pause, 17 = Next, 18 = Previous
const JXA_MEDIA_SCRIPT = '/tmp/macdeck-mediakey.js';

fs.writeFileSync(JXA_MEDIA_SCRIPT, `
function postMediaKey(code, down) {
  ObjC.import('Cocoa');
  var flags = down ? 0xa00 : 0xb00;
  var data1 = (code << 16) | ((down ? 0xa : 0xb) << 8);
  var e = $.NSEvent.otherEventWithTypeLocationModifierFlagsTimestampWindowNumberContextSubtypeData1Data2(
    14, {x:0,y:0}, flags, 0, 0, null, 8, data1, -1
  );
  if (e) $.CGEventPost(0, e.CGEvent);
}
var key = parseInt($.NSProcessInfo.processInfo.environment.objectForKey('MEDIA_KEY'));
postMediaKey(key, true);
postMediaKey(key, false);
`);

function mediaKey(code) {
  return run(`MEDIA_KEY=${code} osascript -l JavaScript "${JXA_MEDIA_SCRIPT}" 2>/dev/null`);
}

// nowplaying-cli is the preferred media controller — works with Chrome, Spotify web,
// YouTube Music, Twitch, Apple Music, etc. JXA is a fallback.
const NOWPLAYING_CLI = ['/opt/homebrew/bin/nowplaying-cli', '/usr/local/bin/nowplaying-cli']
  .find(p => { try { fs.accessSync(p); return true; } catch { return false; } }) || null;

async function mediaControl(npCmd, jxaCode) {
  if (NOWPLAYING_CLI) {
    try { await run(`${NOWPLAYING_CLI} ${npCmd} 2>/dev/null`); return; } catch {}
  }
  mediaKey(jxaCode);
}

// ─── Chrome window helpers ────────────────────────────────────────────────────
function cleanChromeTitle(raw) {
  return raw
    .replace(/^\(\d+\)\s+/, '')           // strip "(5) " notification prefix
    .replace(/\s+-\s+Google Chrome$/, '') // strip " - Google Chrome" suffix
    .replace(/\s+-\s+.*$/, '');           // strip any trailing " - Sitename"
}

async function getChromeWindows() {
  try {
    // Returns index~title| for each window
    const raw = await run(`osascript -e '
      tell application "Google Chrome"
        set out to ""
        set idx to 0
        repeat with w in windows
          set idx to idx + 1
          set t to title of active tab of w
          set out to out & idx & "~" & t & "|"
        end repeat
        return out
      end tell
    ' 2>/dev/null`);
    return raw.split('|').filter(s => s.trim()).map(entry => {
      const tilde = entry.indexOf('~');
      return {
        index: parseInt(entry.slice(0, tilde), 10),
        title: cleanChromeTitle(entry.slice(tilde + 1).trim()),
      };
    });
  } catch { return []; }
}

// ─── Running apps ─────────────────────────────────────────────────────────────
const appPathCache = {};

async function getRunningApps() {
  try {
    const raw = await run(`osascript -e '
      set out to ""
      tell application "System Events"
        set procs to every process whose visible is true and background only is false
        repeat with p in procs
          try
            set n to name of p
            try
              set ap to POSIX path of (application file of p)
            on error
              set ap to ""
            end try
            set out to out & n & "|" & ap & "~"
          end try
        end repeat
      end tell
      return out
    '`);

    const results = [];
    for (const entry of raw.split('~')) {
      const trimmed = entry.trim();
      if (!trimmed) continue;
      const bar = trimmed.indexOf('|');
      const name    = trimmed.slice(0, bar).trim();
      const appPath = trimmed.slice(bar + 1).trim();
      if (!name || HIDDEN_PROCS.has(name)) continue;
      if (appPath) appPathCache[name] = appPath;
      results.push({ name, appPath });
    }

    // Expand Google Chrome → one entry per window (so each profile/tab is tappable)
    const chromeIdx = results.findIndex(a => a.name === 'Google Chrome');
    if (chromeIdx !== -1) {
      const chromeAppPath = results[chromeIdx].appPath;
      const windows = await getChromeWindows();
      if (windows.length > 1) {
        const expanded = windows.map(w => ({
          name:              w.title.length > 24 ? w.title.slice(0, 23) + '…' : w.title,
          appPath:           chromeAppPath,
          appName:           'Google Chrome',
          chromeWindowIndex: w.index,
          iconName:          'Google Chrome', // always use Chrome icon
        }));
        results.splice(chromeIdx, 1, ...expanded);
      }
      // Single Chrome window: just leave it as-is (no expansion needed)
    }

    return results;
  } catch { return []; }
}

// ─── App icon extraction ──────────────────────────────────────────────────────
const iconCache = new Map();

async function getAppIcon(appName) {
  if (iconCache.has(appName)) return iconCache.get(appName);
  iconCache.set(appName, null);
  try {
    let appBase = appPathCache[appName];
    if (!appBase) {
      appBase = await run(
        `osascript -e 'POSIX path of (path to application "${appName.replace(/"/g, '')}") 2>/dev/null' 2>/dev/null`
      ).catch(() => '');
    }
    if (!appBase) return null;
    const clean = appBase.replace(/\/$/, '');
    const plist = `${clean}/Contents/Info.plist`;
    let iconFile = await run(`defaults read "${plist}" CFBundleIconFile 2>/dev/null`).catch(() => '');
    if (!iconFile) iconFile = await run(`defaults read "${plist}" CFBundleIconName 2>/dev/null`).catch(() => '');
    if (!iconFile) return null;
    if (!iconFile.endsWith('.icns')) iconFile += '.icns';
    const icnsPath = `${clean}/Contents/Resources/${iconFile}`;
    const tmpPng   = `/tmp/macdeck-icon-${appName.replace(/[^a-zA-Z0-9]/g, '_')}.png`;
    await run(`sips -s format png "${icnsPath}" --out "${tmpPng}" --resampleHeightWidth 96 96 2>/dev/null`);
    const buf = fs.readFileSync(tmpPng);
    iconCache.set(appName, buf);
    return buf;
  } catch { return null; }
}

// ─── Volume / now playing ─────────────────────────────────────────────────────
async function getVolumeState() {
  try {
    const [vol, muted] = await Promise.all([
      run(`osascript -e "output volume of (get volume settings)"`),
      run(`osascript -e "output muted of (get volume settings)"`),
    ]);
    return { volume: parseInt(vol) || 0, muted: muted === 'true' };
  } catch { return { volume: 50, muted: false }; }
}

async function getNowPlaying() {
  // nowplaying-cli (if installed) covers Chrome media sessions, Spotify, etc.
  for (const bin of ['/opt/homebrew/bin/nowplaying-cli', '/usr/local/bin/nowplaying-cli']) {
    try {
      const title = await run(`${bin} get title 2>/dev/null`);
      if (title && title !== 'null') {
        const [artist, rate] = await Promise.all([
          run(`${bin} get artist 2>/dev/null`).catch(() => ''),
          run(`${bin} get playbackRate 2>/dev/null`).catch(() => '1'),
        ]);
        return {
          title,
          artist:    artist !== 'null' ? artist : '',
          isPlaying: parseFloat(rate) > 0,
        };
      }
    } catch {}
  }
  // Fallback: desktop apps
  for (const app of ['Spotify', 'Music']) {
    try {
      const info = await run(
        `osascript -e 'if application "${app}" is running then (name of current track of application "${app}") & "|||" & (artist of current track of application "${app}")' 2>/dev/null`
      );
      if (info?.includes('|||')) {
        const [t, a] = info.split('|||');
        return { title: t.trim(), artist: a.trim(), isPlaying: true };
      }
    } catch {}
  }
  return null;
}

// ─── Action handler ───────────────────────────────────────────────────────────
async function handleAction(action, payload = {}) {
  switch (action) {
    case 'volumeUp':
      await run(`osascript -e "set volume output volume (((output volume of (get volume settings)) + 5) as integer)"`);
      return getVolumeState();
    case 'volumeDown':
      await run(`osascript -e "set volume output volume (((output volume of (get volume settings)) - 5) as integer)"`);
      return getVolumeState();
    case 'setVolume':
      await run(`osascript -e "set volume output volume ${parseInt(payload.level, 10)}"`);
      return getVolumeState();
    case 'toggleMute':
      await run(`osascript -e "set s to get volume settings\nif output muted of s then\nset volume without output muted\nelse\nset volume with output muted\nend if"`);
      return getVolumeState();

    // Media — nowplaying-cli preferred, JXA fallback
    case 'playPause': await mediaControl('togglePlayPause', 16); break;
    case 'nextTrack': await mediaControl('next',            17); break;
    case 'prevTrack': await mediaControl('previous',        18); break;

    case 'switchApp': {
      if (payload.chromeWindowIndex) {
        run(`osascript -e '
          tell application "Google Chrome"
            set index of window ${payload.chromeWindowIndex} to 1
            activate
          end tell
        '`).catch(() => {});
      } else {
        const target = payload.appPath || payload.appName || payload.name;
        run(`osascript -e 'tell application "${target}" to activate'`).catch(() => {});
      }
      break;
    }

    case 'launchApp': {
      const target = payload.appPath || payload.appName || payload.name;
      run(`open -a "${target.replace(/"/g, '\\"')}" 2>/dev/null`).catch(() => {});
      break;
    }

    case 'wakeDisplay':    run(`caffeinate -u -t 1`).catch(() => {}); break;
    case 'lock':           run(`/System/Library/CoreServices/Menu\\ Extras/User.menu/Contents/Resources/CGSession -suspend 2>/dev/null || pmset displaysleepnow`).catch(() => {}); break;
    case 'sleep':          run(`osascript -e 'tell application "System Events" to sleep'`).catch(() => {}); break;
    case 'missionControl': run(`osascript -e 'tell application "Mission Control" to launch'`).catch(() => {}); break;
    case 'screenshot': {
      const file = `${os.homedir()}/Pictures/Screenshots/screenshot-${Date.now()}.png`;
      run(`mkdir -p "${os.homedir()}/Pictures/Screenshots"`)
        .then(() => run(`screencapture -x "${file}"`))
        .catch(() => {});
      break;
    }
  }
  return null;
}

// ─── All installed apps ───────────────────────────────────────────────────────
let allAppsCache = null;
function getAllApps() {
  if (allAppsCache) return allAppsCache;
  const dirs = [
    '/Applications',
    '/Applications/Utilities',
    '/System/Applications',
    '/System/Applications/Utilities',
    `${os.homedir()}/Applications`,
  ];
  const seen = new Set();
  const apps = [];
  for (const dir of dirs) {
    try {
      fs.readdirSync(dir)
        .filter(f => f.endsWith('.app'))
        .forEach(f => {
          const name = f.replace(/\.app$/, '');
          if (seen.has(name)) return;
          seen.add(name);
          apps.push({ name, appPath: `${dir}/${f}`, appName: name });
        });
    } catch {}
  }
  apps.sort((a, b) => a.name.localeCompare(b.name));
  allAppsCache = apps;
  // Bust cache every 5 min in case user installs something
  setTimeout(() => { allAppsCache = null; }, 5 * 60 * 1000);
  return apps;
}

// ─── HTTP server ──────────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript',
  '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon',
};

const server = http.createServer(async (req, res) => {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';

  if (urlPath === '/config.json') {
    res.writeHead(200, { 'Content-Type': MIME['.json'] });
    return res.end(JSON.stringify({ macAddress: MAC_ADDRESS, version: SERVER_VERSION }));
  }
  if (urlPath === '/api/version') {
    res.writeHead(200, { 'Content-Type': MIME['.json'] });
    return res.end(JSON.stringify({ version: SERVER_VERSION }));
  }
  if (urlPath === '/api/all-apps') {
    res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'max-age=300' });
    return res.end(JSON.stringify({ apps: getAllApps() }));
  }
  if (urlPath === '/api/running-apps') {
    const apps = await getRunningApps();
    res.writeHead(200, { 'Content-Type': MIME['.json'] });
    return res.end(JSON.stringify({ apps }));
  }
  if (urlPath.startsWith('/api/icon/')) {
    // iconName param lets Chrome windows reuse the Chrome icon
    const appName = decodeURIComponent(urlPath.slice('/api/icon/'.length));
    const icon = await getAppIcon(appName);
    if (icon) {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=600' });
      return res.end(icon);
    }
    res.writeHead(404); return res.end('no icon');
  }

  const filePath = path.join(PUBLIC_DIR, urlPath);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  try {
    const content = fs.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(content);
  } catch { res.writeHead(404); res.end('Not found'); }
});

// ─── WebSocket ────────────────────────────────────────────────────────────────
const wss = new WebSocket.Server({ server });

function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

let lastStateStr = '';
async function pollState() {
  const [vol, np] = await Promise.all([getVolumeState(), getNowPlaying()]);
  const state = { type: 'state', ...vol, nowPlaying: np };
  const str = JSON.stringify(state);
  if (str !== lastStateStr) { lastStateStr = str; broadcast(state); }
}
setInterval(pollState, 5000);

let lastAppsStr = '';
async function pollApps() {
  const apps = await getRunningApps();
  const str = JSON.stringify(apps);
  if (str !== lastAppsStr) { lastAppsStr = str; broadcast({ type: 'runningApps', apps }); }
}
setInterval(pollApps, 3000);

// ─── Caffeinate: keep Mac awake while phone is connected ──────────────────────
let caffeinateProc = null, connectionCount = 0;
function startCaffeinate() {
  if (caffeinateProc) return;
  caffeinateProc = exec('caffeinate -d -i -u');
  console.log('☕  Caffeinate started');
}
function stopCaffeinate() {
  if (!caffeinateProc) return;
  caffeinateProc.kill(); caffeinateProc = null;
  console.log('💤  Caffeinate stopped');
}

wss.on('connection', async (ws, req) => {
  connectionCount++;
  if (connectionCount === 1) startCaffeinate();
  console.log(`📱  Phone connected (${connectionCount} active)`);

  ws.send(JSON.stringify({ type: 'version', version: SERVER_VERSION }));

  const [vol, np, runningApps] = await Promise.all([getVolumeState(), getNowPlaying(), getRunningApps()]);
  ws.send(JSON.stringify({ type: 'state', ...vol, nowPlaying: np }));
  ws.send(JSON.stringify({ type: 'runningApps', apps: runningApps }));

  ws.on('message', async (raw) => {
    try {
      const { action, payload } = JSON.parse(raw);
      const result = await handleAction(action, payload || {});
      if (result) ws.send(JSON.stringify({ type: 'state', ...result }));
    } catch (e) { console.error('Action error:', e.message); }
  });

  ws.on('close', () => {
    connectionCount = Math.max(0, connectionCount - 1);
    if (connectionCount === 0) stopCaffeinate();
    console.log(`📵  Phone disconnected (${connectionCount} remaining)`);
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
function getLocalIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets))
    for (const net of nets[name])
      if (net.family === 'IPv4' && !net.internal) return net.address;
  return 'localhost';
}

server.listen(PORT, () => {
  console.log('\n🎛️  Mac Deck running!\n');
  console.log(`   WiFi  →  http://${getLocalIP()}:${PORT}`);
  console.log(`   USB   →  http://localhost:${PORT}   (adb reverse tcp:${PORT} tcp:${PORT})\n`);
});
