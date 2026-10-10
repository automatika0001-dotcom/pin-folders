const { app, BrowserWindow, screen, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { autoUpdater } = require('electron-updater');

// ---------- config ----------
const config = (() => {
  const defaults = {
    serverUrl: '',
    accessKey: '',
    discordFlavor: 'stable',
    panelWidth: 380,
    closeDiscordCompletely: true,
    updateCheckMinutes: 30,
  };
  try {
    return { ...defaults, ...JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8')) };
  } catch {
    return defaults;
  }
})();

const FLAVORS = {
  stable: { exe: 'Discord.exe', dir: 'Discord' },
  ptb: { exe: 'DiscordPTB.exe', dir: 'DiscordPTB' },
  canary: { exe: 'DiscordCanary.exe', dir: 'DiscordCanary' },
};
const flavor = FLAVORS[config.discordFlavor] || FLAVORS.stable;

const isWin = process.platform === 'win32';
const dw = isWin ? require('./discordWindow') : null;

// ---------- state ----------
let panel = null;
let panelHwnd = 0;
let discord = 0; // Discord window handle
let discordSeen = false;
let quitting = false;
let ignoreGeometryUntil = 0;
let ignorePanelStateUntil = 0; // panel minimize/restore events we caused ourselves
let lastDiscordRect = null;
let lastPanelRect = null;
let lastDiscordMin = null;
let missingSince = null;
let lastForeground = 0;
let lastTitle = null;
let titleTick = 0;
let syncTimer = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!panel) return;
    if (discord && dw.isMinimized(discord)) dw.restore(discord);
    showPanelQuietly();
    layout();
    panel.focus();
  });
  app.whenReady().then(start);
}

async function start() {
  createPanel();
  setupUpdater();

  if (!isWin) {
    panel.show(); // dev convenience on other systems
    return;
  }

  launchDiscord();
  placePanelAlone();
  panel.show();
  send('discord:status', 'searching');

  discord = await waitForDiscord(90000);
  if (discord) {
    discordSeen = true;
    send('discord:status', 'ok');
    layout();
  } else {
    send('discord:status', 'missing');
  }
  syncTimer = setInterval(tick, 100);
}

function createPanel() {
  panel = new BrowserWindow({
    width: config.panelWidth,
    height: 800,
    minWidth: 280,
    minHeight: 400,
    show: false,
    frame: false,
    backgroundColor: '#1a1a1e',
    title: 'Pin Folders',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  panel.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  panelHwnd = Number(panel.getNativeWindowHandle().readBigUInt64LE(0));

  panel.on('move', onPanelGeometry);
  panel.on('resize', onPanelGeometry);

  // User minimized the panel (button or taskbar): minimize Discord too.
  panel.on('minimize', () => {
    if (Date.now() < ignorePanelStateUntil) return;
    if (discordOk() && !dw.isMinimized(discord)) {
      lastDiscordMin = true;
      dw.minimize(discord);
    }
  });
  // User restored the panel (taskbar): bring Discord back too.
  panel.on('restore', () => {
    if (Date.now() < ignorePanelStateUntil) return;
    if (discordOk() && dw.isMinimized(discord)) {
      lastDiscordMin = false;
      dw.restore(discord);
      setTimeout(afterDiscordRestored, 150);
    }
    raiseDiscordBehindPanel();
  });
  panel.on('focus', raiseDiscordBehindPanel);
  panel.on('close', (e) => {
    if (!quitting) {
      e.preventDefault(); // Alt+F4 or taskbar close: close both
      shutdown();
    }
  });
  panel.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  panel.webContents.on('did-finish-load', () => {
    lastTitle = null; // resend the Discord title after a reload
  });
}

function send(channel, payload) {
  if (panel && !panel.isDestroyed()) panel.webContents.send(channel, payload);
}

const discordOk = () => discord && dw.isAlive(discord);

// ---------- Discord process ----------
function launchDiscord() {
  const updater = path.join(process.env.LOCALAPPDATA || '', flavor.dir, 'Update.exe');
  if (fs.existsSync(updater)) {
    // Starts Discord, or brings it back from the tray if it's already running.
    spawn(updater, ['--processStart', flavor.exe], { detached: true, stdio: 'ignore' }).unref();
  } else {
    shell.openExternal('discord://').catch(() => {});
  }
}

function killDiscord() {
  spawn('taskkill', ['/IM', flavor.exe, '/T', '/F'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

async function waitForDiscord(timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const hwnd = dw.findDiscordWindow(flavor.exe);
    if (hwnd) {
      await sleep(600); // let Discord finish its own window setup
      return dw.findDiscordWindow(flavor.exe) || hwnd;
    }
    await sleep(300);
  }
  return 0;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- geometry helpers (Discord is handled in physical pixels) ----------
function panelPhys() {
  return screen.dipToScreenRect(panel, panel.getBounds());
}

function setPanelPhys(rect) {
  setPanelDip(screen.screenToDipRect(null, rect));
}

function setPanelDip(rect) {
  ignoreGeometryUntil = Date.now() + 250;
  panel.setBounds({
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  });
  lastPanelRect = panelPhys();
}

const sameRect = (a, b) =>
  a && b && Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1 && Math.abs(a.width - b.width) <= 1 && Math.abs(a.height - b.height) <= 1;

function placePanelAlone() {
  const wa = screen.getPrimaryDisplay().workArea;
  setPanelDip({ x: wa.x + wa.width - config.panelWidth, y: wa.y, width: config.panelWidth, height: wa.height });
}

// Un-minimizes the panel without stealing focus from Discord.
function showPanelQuietly() {
  if (!panel.isMinimized() && panel.isVisible()) return;
  ignorePanelStateUntil = Date.now() + 600;
  if (isWin) dw.showNoActivate(panelHwnd);
  else panel.showInactive();
}

/** Fits Discord + panel side by side, filling Discord's current screen. */
function layout() {
  if (!discordOk()) return placePanelAlone();
  if (dw.isMinimized(discord) || dw.isMaximized(discord)) dw.restore(discord);
  showPanelQuietly();

  const current = screen.screenToDipRect(null, dw.getRect(discord));
  const wa = screen.getDisplayMatching(current).workArea;
  const pw = Math.min(lastPanelRect ? screen.screenToDipRect(null, lastPanelRect).width : config.panelWidth, Math.floor(wa.width / 2));

  setPanelDip({ x: wa.x + wa.width - pw, y: wa.y, width: pw, height: wa.height });
  dw.setRect(discord, screen.dipToScreenRect(null, { x: wa.x, y: wa.y, width: wa.width - pw, height: wa.height }));
  lastDiscordRect = dw.getRect(discord);
  raiseDiscordBehindPanel();
  panel.moveTop();
}

function raiseDiscordBehindPanel() {
  if (discordOk() && !dw.isMinimized(discord)) dw.placeBehind(discord, panelHwnd);
}

// Discord just came back from being minimized.
function afterDiscordRestored() {
  if (!discordOk() || dw.isMinimized(discord)) return;
  showPanelQuietly();
  if (dw.isMaximized(discord)) return layout(); // was maximized before: fill the screen together
  followDiscord(true);
  panel.moveTop();
}

// Keeps the panel glued to Discord's right edge.
function followDiscord(force = false) {
  const r = dw.getRect(discord);
  if (!force && sameRect(r, lastDiscordRect)) return;
  lastDiscordRect = r;
  const p = panelPhys();
  setPanelPhys({ x: r.x + r.width, y: r.y, width: p.width, height: r.height });
}

// User dragged or resized the panel: Discord follows.
function onPanelGeometry() {
  if (!panel || panel.isMinimized()) return;
  const p = panelPhys();
  const prev = lastPanelRect || p;
  lastPanelRect = p;
  if (Date.now() < ignoreGeometryUntil || !discordOk() || dw.isMinimized(discord)) return;

  const d = dw.getRect(discord);
  let next;
  if (Math.abs(p.width - prev.width) > 1) {
    next = { x: d.x, y: p.y, width: Math.max(400, p.x - d.x), height: p.height };
  } else {
    next = { x: p.x - d.width, y: p.y, width: d.width, height: p.height };
  }
  dw.setRect(discord, next);
  lastDiscordRect = dw.getRect(discord);
}

// Watches Discord ~10x per second and mirrors its state onto the panel.
function tick() {
  if (quitting) return;

  if (!discord || !dw.isWindow(discord)) {
    const found = dw.findDiscordWindow(flavor.exe);
    if (found && found !== discord) {
      discord = found;
      lastDiscordMin = null;
      if (!discordSeen) {
        discordSeen = true;
        send('discord:status', 'ok');
        layout();
      }
    }
  }

  if (!discordOk()) {
    // Discord was closed (or sent to tray with its X). Close everything.
    if (discordSeen) {
      missingSince ??= Date.now();
      if (Date.now() - missingSince > 1200) shutdown();
    }
    return;
  }
  missingSince = null;

  // Tell the panel which channel Discord is showing (from the window title).
  if (++titleTick % 2 === 0) { // every 0.2s (was 0.5s)
    const title = dw.title(discord);
    if (title && title !== lastTitle) {
      lastTitle = title;
      send('discord:title', title);
    }
  }

  // Minimize / restore together. Only react to changes, so we never fight
  // the user while Windows is animating.
  const dMin = dw.isMinimized(discord);
  if (lastDiscordMin === null) lastDiscordMin = dMin;
  if (dMin !== lastDiscordMin) {
    lastDiscordMin = dMin;
    if (dMin) {
      if (!panel.isMinimized()) {
        ignorePanelStateUntil = Date.now() + 600;
        panel.minimize();
      }
    } else {
      afterDiscordRestored();
    }
    return;
  }
  if (dMin) return;

  // Discord was maximized (button, double-click or snap): fill the screen
  // with Discord + panel instead of letting Discord cover the panel.
  if (dw.isMaximized(discord)) return layout();

  if (panel.isMinimized()) showPanelQuietly();

  followDiscord();

  // Clicking into Discord brings the panel up with it (without stealing focus).
  const fg = dw.foreground();
  if (fg !== lastForeground) {
    if (fg === discord) panel.moveTop();
    lastForeground = fg;
  }
}

function shutdown() {
  if (quitting) return;
  quitting = true;
  clearInterval(syncTimer);
  if (isWin && config.closeDiscordCompletely) killDiscord();
  app.quit();
}

// ---------- IPC ----------
ipcMain.handle('get-config', () => ({
  serverUrl: config.serverUrl,
  accessKey: config.accessKey,
  version: app.getVersion(),
}));
ipcMain.on('win:minimize', () => panel.minimize());
ipcMain.on('win:close', () => shutdown());
ipcMain.on('win:snap', () => layout());
ipcMain.on('open-message', (_e, { guildId, channelId, messageId }) => {
  if (![guildId, channelId, messageId].every((v) => /^\d{5,25}$/.test(String(v)))) return;
  if (discordOk() && dw.isMinimized(discord)) dw.restore(discord);
  shell.openExternal(`discord://-/channels/${guildId}/${channelId}/${messageId}`);
});
ipcMain.on('open-external', (_e, url) => {
  if (/^https?:\/\//.test(String(url))) shell.openExternal(url);
});
ipcMain.on('update:install', () => {
  // Restart into the new version but leave Discord running; the new
  // version re-attaches to it on launch.
  quitting = true;
  clearInterval(syncTimer);
  autoUpdater.quitAndInstall(true, true);
});
ipcMain.on('update:check', () => {
  if (!app.isPackaged) return send('update:status', { state: 'dev' });
  if (updateReadyVersion) return send('update:status', { state: 'ready', version: updateReadyVersion });
  autoUpdater.checkForUpdates().catch((e) => send('update:status', { state: 'error', message: e?.message }));
});

// ---------- auto-update ----------
let updateReadyVersion = null;
function setupUpdater() {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true; // if ignored, installs next time you close
  autoUpdater.on('checking-for-update', () => send('update:status', { state: 'checking' }));
  autoUpdater.on('update-not-available', () => send('update:status', { state: 'none' }));
  autoUpdater.on('update-available', (i) => send('update:status', { state: 'downloading', version: i.version, percent: 0 }));
  autoUpdater.on('download-progress', (p) => send('update:status', { state: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (i) => {
    updateReadyVersion = i.version;
    send('update:status', { state: 'ready', version: i.version });
  });
  autoUpdater.on('error', (e) => send('update:status', { state: 'error', message: e?.message }));
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, 5000);
  setInterval(check, Math.max(5, config.updateCheckMinutes) * 60 * 1000);
}

app.on('window-all-closed', () => app.quit());
