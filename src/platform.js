// Windows integration: logs folder, crash safety, tray, start-with-Windows, Chrome detection.
const fs = require("fs");
const path = require("path");

function setupLogging(app) {
  app.setAppLogsPath();                                   // %APPDATA%\DealerOS Marketplace\logs
  const dir = app.getPath("logs"); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `dealeros-marketplace-${new Date().toISOString().slice(0, 10)}.log`);
  const write = (lvl, args) => {
    const line = `${new Date().toISOString()} [${lvl}] ${args.map(a => (a instanceof Error ? a.stack : typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`;
    try { fs.appendFileSync(file, line.replace(/(dm[xr]_)[\w-]{8,}/g, "$1***")); } catch {}   // never log tokens
  };
  for (const lvl of ["log", "warn", "error"]) { const orig = console[lvl]; console[lvl] = (...a) => { write(lvl.toUpperCase(), a); orig(...a); }; }
  // prune logs older than 14 days
  for (const f of fs.readdirSync(dir)) { try { const p = path.join(dir, f); if (Date.now() - fs.statSync(p).mtimeMs > 14 * 864e5) fs.rmSync(p); } catch {} }
  return { dir, file };
}

function setupCrashSafety(app, getWin) {
  process.on("uncaughtException", e => console.error("uncaughtException", e));
  process.on("unhandledRejection", e => console.error("unhandledRejection", e));
  app.on("render-process-gone", (_e, _wc, d) => { console.error("renderer gone", d); const w = getWin(); if (w && !w.isDestroyed()) setTimeout(() => w.reload(), 1500); });
  app.on("child-process-gone", (_e, d) => console.error("child process gone", d));
}

// Start at login. Windows: Run key with --hidden. macOS: Login Items (openAsHidden).
function loginItem(on, platform = process.platform) {
  return platform === "darwin" ? { openAtLogin: on, openAsHidden: true } : { openAtLogin: on, args: ["--hidden"] };
}

const MAC_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
function findChrome(platform = process.platform, exists = fs.existsSync, env = process.env) {
  if (platform === "darwin") {
    for (const p of [MAC_CHROME, path.join(env.HOME || "", "Applications/Google Chrome.app/Contents/MacOS/Google Chrome")]) if (exists(p)) return p;
    return null;
  }
  if (platform !== "win32") return null;
  const bases = [env["PROGRAMFILES"], env["PROGRAMFILES(X86)"], env["LOCALAPPDATA"]].filter(Boolean);
  for (const b of bases) { const p = path.join(b, "Google", "Chrome", "Application", "chrome.exe"); if (exists(p)) return p; }
  return null;
}

function setupTray(app, { Tray, Menu, nativeImage }, iconPath, getWin, actions) {
  const tray = new Tray(nativeImage.createFromPath(iconPath));
  tray.setToolTip("DealerOS Marketplace");
  const menu = () => Menu.buildFromTemplate([
    { label: "Open DealerOS Marketplace", click: () => { const w = getWin(); w.show(); w.focus(); } },
    { label: "Sync leads now", click: actions.pollLeads },
    { type: "separator" },
    { label: process.platform === "darwin" ? "Open at Login" : "Start with Windows", type: "checkbox", checked: app.getLoginItemSettings().openAtLogin,
      click: i => app.setLoginItemSettings(loginItem(i.checked)) },
    { label: "Open logs folder", click: actions.openLogs },
    { type: "separator" },
    { label: "Quit", click: () => { app.isQuitting = true; app.quit(); } }
  ]);
  tray.setContextMenu(menu());
  tray.on("click", () => { const w = getWin(); w.isVisible() ? w.focus() : w.show(); });
  tray.on("right-click", () => tray.setContextMenu(menu()));
  return tray;
}
module.exports = { setupLogging, setupCrashSafety, findChrome, setupTray, loginItem, MAC_CHROME };
