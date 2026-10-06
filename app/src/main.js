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
let lastDiscordRect = null;
let lastPanelRect = null;
let missingSince = null;
let lastForeground = 0;
let syncTimer = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!panel) return;
    panel.showInactive();
    if (discord && dw.isMinimized(discord)) dw.restore(discord);
    layout();
    panel.focus();
  });
  app.whenReady().then(start);
}

async function start() {
  createPanel();
  setupUpdater();

  if (!isWin) {
    // Dev convenience on other systems: just show the panel.
    panel.show();
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
    backgroundColor: '#1e1f22',
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
  panel.on('minimize', () => {
    if (discord && dw.isAlive(discord) && !dw.isMinimized(discord)) dw.minimize(discord);
  });
  panel.on('restore', () => {
    if (discord && dw.isAlive(discord) && dw.isMinimized(discord)) dw.restore(discord);
    raiseDiscordBehindPanel();
  });
  panel.on('focus', raiseDiscordBehindPanel);
  panel.on('close', (e) => {
    if (!quitting) {
      e.preventDefault(); // Alt+F4 or taskbar close: close both
      shutdown();
    }
  });
  // Links inside the panel open in the real browser.
  panel.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

function send(channel, payload) {
  if (panel && !panel.isDestroyed()) panel.webContents.send(channel, payload);
}

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

/** Fits Discord + panel side by side on Discord's current screen. */
function layout() {
  if (!discord || !dw.isAlive(discord)) return placePanelAlone();
  if (dw.isMinimized(discord) || dw.isMaximized(discord)) dw.restore(discord);

  const current = screen.screenToDipRect(null, dw.getRect(discord));
  const wa = screen.getDisplayMatching(current).workArea;
  const pw = Math.min(config.panelWidth, Math.floor(wa.width / 2));

  setPanelDip({ x: wa.x + wa.width - pw, y: wa.y, width: pw, height: wa.height });
  dw.setRect(discord, screen.dipToScreenRect(null, { x: wa.x, y: wa.y, width: wa.width - pw, height: wa.height }));
  lastDiscordRect = dw.getRect(discord);
  raiseDiscordBehindPanel();
}

function raiseDiscordBehindPanel() {
  if (discord && dw.isAlive(discord) && !dw.isMinimized(discord)) dw.placeBehind(discord, panelHwnd);
}

// User dragged or resized the panel: Discord follows.
function onPanelGeometry() {
  if (!panel || panel.isMinimized()) return;
  const p = panelPhys();
  const prev = lastPanelRect || p;
  lastPanelRect = p;
  if (Date.now() < ignoreGeometryUntil || !discord || !dw.isAlive(discord) || dw.isMinimized(discord)) return;

  const d = dw.getRect(discord);
  let next;
  if (Math.abs(p.width - prev.width) > 1) {
    // Panel resized from its left edge: Discord keeps its left side and shrinks/grows.
    next = { x: d.x, y: p.y, width: Math.max(400, p.x - d.x), height: p.height };
  } else {
    // Panel moved: Discord moves with it, glued to its left edge.
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
      if (!discordSeen) {
        discordSeen = true;
        send('discord:status', 'ok');
        layout();
      }
    }
  }

  if (!discord || !dw.isAlive(discord)) {
    // Discord was closed (or sent to tray with its X). Close everything.
    if (discordSeen) {
      missingSince ??= Date.now();
      if (Date.now() - missingSince > 1200) shutdown();
    }
    return;
  }
  missingSince = null;

  // Minimize / restore together
  const dMin = dw.isMinimized(discord);
  if (dMin && !panel.isMinimized()) panel.minimize();
  else if (!dMin && panel.isMinimized()) panel.showInactive();
  if (dMin) return;

  // Someone maximized Discord: re-fit so the panel stays visible.
  if (dw.isMaximized(discord)) return layout();

  // Discord moved/resized: the panel follows, glued to its right edge.
  const r = dw.getRect(discord);
  if (!sameRect(r, lastDiscordRect)) {
    lastDiscordRect = r;
    const p = panelPhys();
    setPanelPhys({ x: r.x + r.width, y: r.y, width: p.width, height: r.height });
  }

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
  shell.openExternal(`discord://-/channels/${guildId}/${channelId}/${messageId}`);
  if (discord && dw.isMinimized(discord)) dw.restore(discord);
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

// ---------- auto-update ----------
function setupUpdater() {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true; // if ignored, installs next time you close
  autoUpdater.on('update-available', (i) => send('update:status', { state: 'downloading', version: i.version, percent: 0 }));
  autoUpdater.on('download-progress', (p) => send('update:status', { state: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (i) => send('update:status', { state: 'ready', version: i.version }));
  autoUpdater.on('error', (e) => console.error('Updater:', e?.message));
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, 5000);
  setInterval(check, Math.max(5, config.updateCheckMinutes) * 60 * 1000);
}

app.on('window-all-closed', () => app.quit());
