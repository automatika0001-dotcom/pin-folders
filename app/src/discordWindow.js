// Finds and controls the real Discord desktop window through the Win32 API.
// We only move, resize, minimize and order the window. We never inject into
// or modify Discord itself.
const koffi = require('koffi');

const user32 = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');
const dwmapi = koffi.load('dwmapi.dll');

koffi.struct('RECT', { left: 'int32_t', top: 'int32_t', right: 'int32_t', bottom: 'int32_t' });
koffi.proto('int __stdcall EnumWindowsProc(intptr_t hwnd, intptr_t lParam)');

const EnumWindows = user32.func('int __stdcall EnumWindows(EnumWindowsProc *cb, intptr_t lParam)');
const GetWindowThreadProcessId = user32.func('uint32_t __stdcall GetWindowThreadProcessId(intptr_t hWnd, _Out_ uint32_t *pid)');
const IsWindow = user32.func('int __stdcall IsWindow(intptr_t hWnd)');
const IsWindowVisible = user32.func('int __stdcall IsWindowVisible(intptr_t hWnd)');
const IsIconic = user32.func('int __stdcall IsIconic(intptr_t hWnd)');
const IsZoomed = user32.func('int __stdcall IsZoomed(intptr_t hWnd)');
const GetWindowTextLengthW = user32.func('int __stdcall GetWindowTextLengthW(intptr_t hWnd)');
const GetClassNameW = user32.func('int __stdcall GetClassNameW(intptr_t hWnd, void *buf, int max)');
const GetWindowRect = user32.func('int __stdcall GetWindowRect(intptr_t hWnd, _Out_ RECT *rect)');
const SetWindowPos = user32.func('int __stdcall SetWindowPos(intptr_t hWnd, intptr_t after, int x, int y, int cx, int cy, uint32_t flags)');
const ShowWindow = user32.func('int __stdcall ShowWindow(intptr_t hWnd, int cmd)');
const GetForegroundWindow = user32.func('intptr_t __stdcall GetForegroundWindow()');
const OpenProcess = kernel32.func('intptr_t __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)');
const QueryFullProcessImageNameW = kernel32.func('int __stdcall QueryFullProcessImageNameW(intptr_t h, uint32_t flags, void *buf, _Inout_ uint32_t *size)');
const CloseHandle = kernel32.func('int __stdcall CloseHandle(intptr_t h)');
const DwmGetWindowAttribute = dwmapi.func('int32_t __stdcall DwmGetWindowAttribute(intptr_t hwnd, uint32_t attr, _Out_ RECT *rect, uint32_t size)');

const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOZORDER = 0x0004;
const SWP_NOACTIVATE = 0x0010;
const SW_MINIMIZE = 6;
const SW_RESTORE = 9;
const DWMWA_EXTENDED_FRAME_BOUNDS = 9;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

const h = (v) => Number(v);

// pid -> exe name cache (pids are reused rarely; refresh every 30s)
let exeCache = new Map();
setInterval(() => (exeCache = new Map()), 30000).unref?.();

function exeOf(pid) {
  if (exeCache.has(pid)) return exeCache.get(pid);
  let name = null;
  const proc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
  if (proc) {
    try {
      const buf = Buffer.alloc(2048);
      const size = [1024];
      if (QueryFullProcessImageNameW(proc, 0, buf, size)) {
        name = buf.toString('utf16le', 0, size[0] * 2).split('\\').pop().toLowerCase();
      }
    } finally {
      CloseHandle(proc);
    }
  }
  exeCache.set(pid, name);
  return name;
}

function className(hwnd) {
  const buf = Buffer.alloc(512);
  const n = GetClassNameW(hwnd, buf, 256);
  return buf.toString('utf16le', 0, n * 2);
}

function rawRect(hwnd) {
  const r = {};
  GetWindowRect(hwnd, r);
  return r;
}

// The rectangle you actually see (excludes invisible resize borders on Win10/11).
function visualRect(hwnd) {
  const r = {};
  if (DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, r, 16) === 0 && r.right > r.left) return r;
  return rawRect(hwnd);
}

/** Returns the main Discord window handle, or null. */
function findDiscordWindow(exeName) {
  const target = exeName.toLowerCase();
  let best = null;
  let bestScore = 0;
  EnumWindows((hwnd) => {
    if (!IsWindowVisible(hwnd) || GetWindowTextLengthW(hwnd) === 0) return 1;
    const pid = [0];
    GetWindowThreadProcessId(hwnd, pid);
    if (exeOf(pid[0]) !== target) return 1;
    if (className(hwnd) !== 'Chrome_WidgetWin_1') return 1;
    let score;
    if (IsIconic(hwnd)) {
      score = 1; // minimized main window still counts
    } else {
      const r = rawRect(hwnd);
      const w = r.right - r.left;
      const hh = r.bottom - r.top;
      if (w < 500 || hh < 350) return 1; // skip the small updater splash
      score = w * hh;
    }
    if (score > bestScore) {
      bestScore = score;
      best = h(hwnd);
    }
    return 1;
  }, 0);
  return best;
}

function getRect(hwnd) {
  const r = visualRect(hwnd);
  return { x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top };
}

/** Places the window so its *visible* area matches rect (physical pixels). */
function setRect(hwnd, rect) {
  const raw = rawRect(hwnd);
  const vis = visualRect(hwnd);
  const L = vis.left - raw.left;
  const T = vis.top - raw.top;
  const R = raw.right - vis.right;
  const B = raw.bottom - vis.bottom;
  SetWindowPos(
    hwnd,
    0,
    Math.round(rect.x - L),
    Math.round(rect.y - T),
    Math.round(rect.width + L + R),
    Math.round(rect.height + T + B),
    SWP_NOZORDER | SWP_NOACTIVATE
  );
}

/** Puts Discord directly behind the panel in the z-order (no focus change). */
function placeBehind(hwnd, panelHwnd) {
  SetWindowPos(hwnd, panelHwnd, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
}

module.exports = {
  findDiscordWindow,
  getRect,
  setRect,
  placeBehind,
  isWindow: (hwnd) => !!IsWindow(hwnd),
  isAlive: (hwnd) => !!IsWindow(hwnd) && !!IsWindowVisible(hwnd),
  isMinimized: (hwnd) => !!IsIconic(hwnd),
  isMaximized: (hwnd) => !!IsZoomed(hwnd),
  minimize: (hwnd) => ShowWindow(hwnd, SW_MINIMIZE),
  restore: (hwnd) => ShowWindow(hwnd, SW_RESTORE),
  foreground: () => h(GetForegroundWindow()),
};
