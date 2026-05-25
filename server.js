'use strict';

// Never let a single unhandled rejection crash the whole server
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection (non-fatal):', err?.message || err);
});

const http      = require('http');
const WebSocket = require('ws');
const { exec, execFile } = require('child_process');
const fs        = require('fs');
const path      = require('path');
const os        = require('os');

const PORT           = 3333;
const PUBLIC_DIR     = path.join(__dirname, 'public');
const MAC_ADDRESS    = '10:b5:88:64:cf:e3';
const SERVER_VERSION = Date.now().toString();
const IS_MAC         = process.platform === 'darwin';
const IS_WIN         = process.platform === 'win32';

const HIDDEN_PROCS = new Set([
  // macOS
  'loginwindow', 'Dock', 'SystemUIServer', 'WindowServer',
  'ControlStrip', 'Control Centre', 'Notification Centre',
  'Spotlight', 'TextInputMenuAgent', 'AirPlayUIAgent',
  'WiFiAgent', 'universalaccessd', 'talagent', 'app_mode_loader',
  // Windows
  'explorer', 'TextInputHost', 'StartMenuExperienceHost',
  'SearchHost', 'SearchApp', 'ShellExperienceHost',
  'LockApp', 'WinStore.App',
]);

// ─── Helpers ──────────────────────────────────────────────────────────────────
function run(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: 5000 }, (err, stdout) =>
      err ? reject(err) : resolve(stdout.trim())
    );
  });
}

// Run a PowerShell script (Windows only)
function runPs(script) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 8000 },
      (err, stdout) => err ? reject(err) : resolve(stdout.trim())
    );
  });
}

// ─── JXA media-key simulation (macOS only) ────────────────────────────────────
const JXA_MEDIA_SCRIPT = '/tmp/macdeck-mediakey.js';
if (IS_MAC) {
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
}

function mediaKey(code) {
  return run(`MEDIA_KEY=${code} osascript -l JavaScript "${JXA_MEDIA_SCRIPT}" 2>/dev/null`);
}

const NOWPLAYING_CLI = IS_MAC
  ? ['/opt/homebrew/bin/nowplaying-cli', '/usr/local/bin/nowplaying-cli']
      .find(p => { try { fs.accessSync(p); return true; } catch { return false; } }) || null
  : null;

async function mediaControl(npCmd, jxaCode) {
  if (IS_WIN) {
    // Windows media keys via PowerShell keybd_event
    // VK codes: 0xB3 = PlayPause, 0xB0 = Next, 0xB1 = Prev
    const VK = { togglePlayPause: '0xB3', next: '0xB0', previous: '0xB1' };
    const vk = VK[npCmd] || '0xB3';
    await runPs(`
      Add-Type -TypeDefinition @"
      using System; using System.Runtime.InteropServices;
      public class MK { [DllImport("user32.dll")] public static extern void keybd_event(byte bVk,byte bScan,uint dwFlags,int dwExtraInfo); }
"@
      [MK]::keybd_event(${vk},0,0,0); Start-Sleep -Milliseconds 50; [MK]::keybd_event(${vk},0,2,0)
    `).catch(() => {});
    return;
  }
  if (NOWPLAYING_CLI) {
    try { await run(`${NOWPLAYING_CLI} ${npCmd} 2>/dev/null`); return; } catch {}
  }
  mediaKey(jxaCode);
}

// ─── Chrome window helpers (macOS) ────────────────────────────────────────────
function cleanChromeTitle(raw) {
  return raw
    .replace(/^\(\d+\)\s+/, '')
    .replace(/\s+-\s+Google Chrome$/, '')
    .replace(/\s+-\s+.*$/, '');
}

async function getChromeWindows() {
  try {
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

async function getRunningAppsMac() {
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

  // Expand Chrome → one entry per window
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
        iconName:          'Google Chrome',
      }));
      results.splice(chromeIdx, 1, ...expanded);
    }
  }
  return results;
}

async function getRunningAppsWin() {
  const raw = await runPs(`
    Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -ne '' } |
      Select-Object -Property Name,MainWindowTitle,Path |
      ForEach-Object { $_.Name + '|' + $_.MainWindowTitle + '|' + $_.Path + '~' }
  `);
  const results = [];
  for (const entry of raw.split('~')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const parts = trimmed.split('|');
    const procName = parts[0]?.trim();
    const winTitle = parts[1]?.trim();
    const exePath  = parts[2]?.trim() || '';
    if (!procName || HIDDEN_PROCS.has(procName)) continue;
    // Use the window title as display name (friendlier), fallback to proc name
    const name = winTitle || procName;
    if (exePath) appPathCache[name] = exePath;
    results.push({ name, appPath: exePath, appName: name });
  }
  return results;
}

async function getRunningApps() {
  try {
    return IS_WIN ? await getRunningAppsWin() : await getRunningAppsMac();
  } catch { return []; }
}

// ─── App icon extraction ──────────────────────────────────────────────────────
const iconCache = new Map();

async function getAppIconMac(appName) {
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
  return fs.readFileSync(tmpPng);
}

async function getAppIconWin(appName) {
  const exePath = appPathCache[appName];
  if (!exePath) return null;
  const safePath  = exePath.replace(/'/g, "''");
  const tmpPng    = require('os').tmpdir() + `\\macdeck-icon-${appName.replace(/[^a-zA-Z0-9]/g, '_')}.png`;
  await runPs(`
    Add-Type -AssemblyName System.Drawing
    $ico = [System.Drawing.Icon]::ExtractAssociatedIcon('${safePath}')
    if ($ico) {
      $bmp = $ico.ToBitmap()
      $sized = New-Object System.Drawing.Bitmap($bmp, 96, 96)
      $sized.Save('${tmpPng}', [System.Drawing.Imaging.ImageFormat]::Png)
    }
  `);
  return fs.readFileSync(tmpPng);
}

async function getAppIcon(appName) {
  if (iconCache.has(appName)) return iconCache.get(appName);
  iconCache.set(appName, null);
  try {
    const buf = IS_WIN ? await getAppIconWin(appName) : await getAppIconMac(appName);
    if (buf) iconCache.set(appName, buf);
    return buf || null;
  } catch { return null; }
}

// ─── Volume / now playing ─────────────────────────────────────────────────────
async function getVolumeState() {
  try {
    if (IS_WIN) {
      const raw = await runPs(`
        Add-Type -TypeDefinition @"
        using System; using System.Runtime.InteropServices;
        [Guid("5CDF2C82-841E-4546-9722-0CF74078229A")] [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IAudioEndpointVolume { void _1(); void _2(); void _3(); void _4();
          [PreserveSig] int SetMasterVolumeLevelScalar(float fLevel, Guid pguidEventContext);
          void _6();
          [PreserveSig] int GetMasterVolumeLevelScalar(out float pfLevel);
          void _8(); void _9(); void _10(); void _11(); void _12();
          [PreserveSig] int GetMute(out bool pbMute);
          [PreserveSig] int SetMute(bool bMute, Guid pguidEventContext); }
        [Guid("D666063F-1587-4E43-81F1-B948E807363F")] [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IMMDevice { void _1(); [PreserveSig] int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface); }
        [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6")] [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IMMDeviceEnumerator { void _1(); [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppEndpoint); }
        [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorClass {}
        public class AudioHelper {
          public static float GetVolume() { var e = (IMMDeviceEnumerator)new MMDeviceEnumeratorClass(); IMMDevice d; e.GetDefaultAudioEndpoint(0,1,out d); Guid g=new Guid("5CDF2C82-841E-4546-9722-0CF74078229A"); object o; d.Activate(ref g,23,IntPtr.Zero,out o); var v=(IAudioEndpointVolume)o; float f; v.GetMasterVolumeLevelScalar(out f); return f; }
          public static bool GetMute() { var e = (IMMDeviceEnumerator)new MMDeviceEnumeratorClass(); IMMDevice d; e.GetDefaultAudioEndpoint(0,1,out d); Guid g=new Guid("5CDF2C82-841E-4546-9722-0CF74078229A"); object o; d.Activate(ref g,23,IntPtr.Zero,out o); var v=(IAudioEndpointVolume)o; bool b; v.GetMute(out b); return b; }
          public static void SetVolume(float f) { var e = (IMMDeviceEnumerator)new MMDeviceEnumeratorClass(); IMMDevice d; e.GetDefaultAudioEndpoint(0,1,out d); Guid g=new Guid("5CDF2C82-841E-4546-9722-0CF74078229A"); object o; d.Activate(ref g,23,IntPtr.Zero,out o); var v=(IAudioEndpointVolume)o; v.SetMasterVolumeLevelScalar(f, Guid.Empty); }
          public static void SetMute(bool m) { var e = (IMMDeviceEnumerator)new MMDeviceEnumeratorClass(); IMMDevice d; e.GetDefaultAudioEndpoint(0,1,out d); Guid g=new Guid("5CDF2C82-841E-4546-9722-0CF74078229A"); object o; d.Activate(ref g,23,IntPtr.Zero,out o); var v=(IAudioEndpointVolume)o; v.SetMute(m, Guid.Empty); }
        }
"@ -ReferencedAssemblies @('System.Runtime.InteropServices')
        [AudioHelper]::GetVolume().ToString('F2') + '|' + [AudioHelper]::GetMute().ToString()
      `);
      const [volStr, muteStr] = raw.split('|');
      return { volume: Math.round(parseFloat(volStr) * 100), muted: muteStr?.trim() === 'True' };
    }
    const [vol, muted] = await Promise.all([
      run(`osascript -e "output volume of (get volume settings)"`),
      run(`osascript -e "output muted of (get volume settings)"`),
    ]);
    return { volume: parseInt(vol) || 0, muted: muted === 'true' };
  } catch { return { volume: 50, muted: false }; }
}

async function getNowPlaying() {
  if (IS_WIN) {
    // Windows SMTC (System Media Transport Controls) via PowerShell
    try {
      const raw = await runPs(`
        $mgr = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime]
        $task = $mgr::RequestAsync()
        $task.AsTask().Wait(2000) | Out-Null
        $session = $task.GetResults().GetCurrentSession()
        if ($session) {
          $infoTask = $session.TryGetMediaPropertiesAsync()
          $infoTask.AsTask().Wait(2000) | Out-Null
          $info = $infoTask.GetResults()
          $pbTask = $session.GetPlaybackInfo()
          $playing = ($pbTask.PlaybackStatus -eq 4)  # 4 = Playing
          Write-Output ($info.Title + '|||' + $info.Artist + '|||' + $playing)
        }
      `);
      if (raw?.includes('|||')) {
        const [title, artist, playingStr] = raw.split('|||');
        if (title?.trim()) return { title: title.trim(), artist: artist?.trim() || '', isPlaying: playingStr?.trim() === 'True' };
      }
    } catch {}
    return null;
  }

  // macOS: nowplaying-cli first, then fallback to desktop apps
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

// ─── Windows volume helpers ────────────────────────────────────────────────────
const WIN_VOL_HELPER = IS_WIN ? `
  Add-Type -TypeDefinition @"
  using System; using System.Runtime.InteropServices;
  [Guid("5CDF2C82-841E-4546-9722-0CF74078229A")] [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioEndpointVolume { void _1(); void _2(); void _3(); void _4();
    [PreserveSig] int SetMasterVolumeLevelScalar(float fLevel, Guid pguidEventContext); void _6();
    [PreserveSig] int GetMasterVolumeLevelScalar(out float pfLevel);
    void _8(); void _9(); void _10(); void _11(); void _12();
    [PreserveSig] int GetMute(out bool pbMute);
    [PreserveSig] int SetMute(bool bMute, Guid pguidEventContext); }
  [Guid("D666063F-1587-4E43-81F1-B948E807363F")] [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice { void _1(); [PreserveSig] int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface); }
  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6")] [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator { void _1(); [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppEndpoint); }
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorClass {}
  public class AudioHelper {
    static IAudioEndpointVolume GetEPV() { var e=(IMMDeviceEnumerator)new MMDeviceEnumeratorClass(); IMMDevice d; e.GetDefaultAudioEndpoint(0,1,out d); Guid g=new Guid("5CDF2C82-841E-4546-9722-0CF74078229A"); object o; d.Activate(ref g,23,IntPtr.Zero,out o); return (IAudioEndpointVolume)o; }
    public static float GetVolume() { float f; GetEPV().GetMasterVolumeLevelScalar(out f); return f; }
    public static bool GetMute() { bool b; GetEPV().GetMute(out b); return b; }
    public static void SetVolume(float f) { GetEPV().SetMasterVolumeLevelScalar(f, Guid.Empty); }
    public static void SetMute(bool m) { GetEPV().SetMute(m, Guid.Empty); }
  }
"@ -ReferencedAssemblies @('System.Runtime.InteropServices')` : '';

// ─── Action handler ───────────────────────────────────────────────────────────
async function handleAction(action, payload = {}) {
  // ── Volume ──────────────────────────────────────────────────────────────────
  if (action === 'volumeUp' || action === 'volumeDown' || action === 'setVolume' || action === 'toggleMute') {
    if (IS_WIN) {
      if (action === 'volumeUp') {
        await runPs(`${WIN_VOL_HELPER}; $v=[AudioHelper]::GetVolume(); [AudioHelper]::SetVolume([Math]::Min(1.0f,$v+0.05f))`);
      } else if (action === 'volumeDown') {
        await runPs(`${WIN_VOL_HELPER}; $v=[AudioHelper]::GetVolume(); [AudioHelper]::SetVolume([Math]::Max(0.0f,$v-0.05f))`);
      } else if (action === 'setVolume') {
        const level = Math.max(0, Math.min(100, parseInt(payload.level, 10))) / 100;
        await runPs(`${WIN_VOL_HELPER}; [AudioHelper]::SetVolume(${level}f)`);
      } else if (action === 'toggleMute') {
        await runPs(`${WIN_VOL_HELPER}; $m=[AudioHelper]::GetMute(); [AudioHelper]::SetMute(!$m)`);
      }
    } else {
      if (action === 'volumeUp')
        await run(`osascript -e "set volume output volume (((output volume of (get volume settings)) + 5) as integer)"`);
      else if (action === 'volumeDown')
        await run(`osascript -e "set volume output volume (((output volume of (get volume settings)) - 5) as integer)"`);
      else if (action === 'setVolume')
        await run(`osascript -e "set volume output volume ${parseInt(payload.level, 10)}"`);
      else if (action === 'toggleMute')
        await run(`osascript -e "set s to get volume settings\nif output muted of s then\nset volume without output muted\nelse\nset volume with output muted\nend if"`);
    }
    return getVolumeState();
  }

  switch (action) {
    // Media — fire command, wait for state to settle, push real state back via WS
    case 'playPause':
    case 'nextTrack':
    case 'prevTrack': {
      const cmds = { playPause: ['togglePlayPause', 16], nextTrack: ['next', 17], prevTrack: ['previous', 18] };
      const [npCmd, jxaCode] = cmds[action];
      await mediaControl(npCmd, jxaCode);
      await new Promise(r => setTimeout(r, 700));
      return { nowPlaying: await getNowPlaying() };
    }

    case 'switchApp': {
      if (IS_WIN) {
        const exePath = payload.appPath || '';
        if (exePath) {
          // Bring window to foreground by exe path
          runPs(`
            Add-Type -TypeDefinition @"
            using System; using System.Runtime.InteropServices;
            public class WinHelper {
              [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
              [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
            }
"@
            $proc = Get-Process | Where-Object { $_.Path -eq '${exePath.replace(/'/g, "''")}' -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
            if ($proc) { [WinHelper]::ShowWindow($proc.MainWindowHandle, 9); [WinHelper]::SetForegroundWindow($proc.MainWindowHandle) }
          `).catch(() => {});
        }
      } else if (payload.chromeWindowIndex) {
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
      if (IS_WIN) {
        const exePath = payload.appPath || '';
        if (exePath) run(`start "" "${exePath.replace(/"/g, '\\"')}"`).catch(() => {});
      } else {
        const target = payload.appPath || payload.appName || payload.name;
        run(`open -a "${target.replace(/"/g, '\\"')}" 2>/dev/null`).catch(() => {});
      }
      break;
    }

    case 'wakeDisplay':
      if (IS_WIN) runPs(`(Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern void mouse_event(int f,int x,int y,int c,int e);' -Name U -Namespace W -PassThru)::mouse_event(1,0,0,0,0)`).catch(() => {});
      else run(`caffeinate -u -t 1`).catch(() => {});
      break;

    case 'lock':
      if (IS_WIN) run(`rundll32.exe user32.dll,LockWorkStation`).catch(() => {});
      else run(`/System/Library/CoreServices/Menu\\ Extras/User.menu/Contents/Resources/CGSession -suspend 2>/dev/null || pmset displaysleepnow`).catch(() => {});
      break;

    case 'sleep':
      if (IS_WIN) run(`rundll32.exe powrprof.dll,SetSuspendState 0,1,0`).catch(() => {});
      else run(`osascript -e 'tell application "System Events" to sleep'`).catch(() => {});
      break;

    case 'missionControl':
      if (IS_WIN) {
        // Win+Tab = Task View
        runPs(`
          Add-Type -TypeDefinition @"using System; using System.Runtime.InteropServices;
          public class KH { [DllImport("user32.dll")] public static extern void keybd_event(byte bVk,byte bScan,uint dwFlags,int dwExtraInfo); }"@
          [KH]::keybd_event(0x5B,0,0,0); [KH]::keybd_event(0x09,0,0,0); Start-Sleep -Milliseconds 50;
          [KH]::keybd_event(0x09,0,2,0); [KH]::keybd_event(0x5B,0,2,0)
        `).catch(() => {});
      } else {
        run(`osascript -e 'tell application "Mission Control" to launch'`).catch(() => {});
      }
      break;

    case 'screenshot': {
      if (IS_WIN) {
        const dir  = path.join(os.homedir(), 'Pictures', 'Screenshots');
        const file = path.join(dir, `screenshot-${Date.now()}.png`);
        fs.mkdirSync(dir, { recursive: true });
        runPs(`
          Add-Type -AssemblyName System.Windows.Forms
          Add-Type -AssemblyName System.Drawing
          $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
          $bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
          $g = [System.Drawing.Graphics]::FromImage($bmp)
          $g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
          $bmp.Save('${file.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png)
        `)
          .then(() => console.log('Screenshot saved:', file))
          .catch(e => console.error('Screenshot failed:', e.message));
      } else {
        const dir  = `${os.homedir()}/Pictures/Screenshots`;
        const file = `${dir}/screenshot-${Date.now()}.png`;
        fs.mkdirSync(dir, { recursive: true });
        run(`osascript -e 'do shell script "screencapture -x \\"${file}\\""'`)
          .then(() => console.log('Screenshot saved:', file))
          .catch(e => console.error('Screenshot failed:', e.message));
      }
      break;
    }
  }
  return null;
}

// ─── All installed apps ───────────────────────────────────────────────────────
let allAppsCache = null;

function getAllAppsMac() {
  const dirs = [
    '/Applications', '/Applications/Utilities',
    '/System/Applications', '/System/Applications/Utilities',
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
  return apps;
}

async function getAllAppsWin() {
  // Scan Start Menu shortcuts (covers most installed apps)
  const dirs = [
    `${process.env.ProgramData || 'C:\\ProgramData'}\\Microsoft\\Windows\\Start Menu\\Programs`,
    `${os.homedir()}\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs`,
  ];
  const seen = new Set();
  const apps = [];
  for (const dir of dirs) {
    try {
      const scanDir = (d) => {
        for (const f of fs.readdirSync(d)) {
          const full = path.join(d, f);
          try {
            const stat = fs.statSync(full);
            if (stat.isDirectory()) { scanDir(full); continue; }
            if (f.endsWith('.lnk')) {
              const name = f.replace(/\.lnk$/, '');
              if (!seen.has(name) && !name.startsWith('Uninstall') && !name.startsWith('uninstall')) {
                seen.add(name);
                apps.push({ name, appPath: full, appName: name });
              }
            }
          } catch {}
        }
      };
      scanDir(dir);
    } catch {}
  }
  return apps;
}

function getAllApps() {
  if (allAppsCache) return allAppsCache;
  const result = IS_WIN ? getAllAppsWin() : getAllAppsMac();
  // result may be a Promise (Win) or array (Mac) — normalise
  Promise.resolve(result).then(apps => {
    apps.sort((a, b) => a.name.localeCompare(b.name));
    allAppsCache = apps;
    setTimeout(() => { allAppsCache = null; }, 5 * 60 * 1000);
  });
  // Synchronously return whatever we have (may be [] on first win call)
  return allAppsCache || [];
}
// Warm up cache on start
if (IS_WIN) getAllApps();

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
    return res.end(JSON.stringify({ macAddress: MAC_ADDRESS, version: SERVER_VERSION, platform: process.platform }));
  }
  if (urlPath === '/api/version') {
    res.writeHead(200, { 'Content-Type': MIME['.json'] });
    return res.end(JSON.stringify({ version: SERVER_VERSION }));
  }
  if (urlPath === '/api/all-apps') {
    const apps = await Promise.resolve(IS_WIN ? getAllAppsWin() : getAllAppsMac());
    apps.sort((a, b) => a.name.localeCompare(b.name));
    res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'max-age=300' });
    return res.end(JSON.stringify({ apps }));
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

// ─── Caffeinate: keep Mac awake while phone is connected (macOS only) ─────────
let caffeinateProc = null, connectionCount = 0;
function startCaffeinate() {
  if (!IS_MAC || caffeinateProc) return;
  caffeinateProc = exec('caffeinate -d -i -u');
  console.log('☕  Caffeinate started');
}
function stopCaffeinate() {
  if (!IS_MAC || !caffeinateProc) return;
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
  const platform = IS_WIN ? 'Windows' : IS_MAC ? 'macOS' : process.platform;
  console.log(`\n🎛️  Mac Deck running on ${platform}!\n`);
  console.log(`   WiFi  →  http://${getLocalIP()}:${PORT}`);
  console.log(`   USB   →  http://localhost:${PORT}   (adb reverse tcp:${PORT} tcp:${PORT})\n`);
  if (IS_WIN) console.log('   Tip: make sure Node.js is in PATH and run as your normal user account.\n');
});
