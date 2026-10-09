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

function findChrome() {
  if (process.platform !== "win32") return null;
  const bases = [process.env["PROGRAMFILES"], process.env["PROGRAMFILES(X86)"], process.env["LOCALAPPDATA"]].filter(Boolean);
  for (const b of bases) { const p = path.join(b, "Google", "Chrome", "Application", "chrome.exe"); if (fs.existsSync(p)) return p; }
  return null;
}

function setupTray(app, { Tray, Menu, nativeImage }, iconPath, getWin, actions) {
  const tray = new Tray(nativeImage.createFromPath(iconPath));
  tray.setToolTip("DealerOS Marketplace");
  const menu = () => Menu.buildFromTemplate([
    { label: "Open DealerOS Marketplace", click: () => { const w = getWin(); w.show(); w.focus(); } },
    { label: "Sync leads now", click: actions.pollLeads },
    { type: "separator" },
    { label: "Start with Windows", type: "checkbox", checked: app.getLoginItemSettings().openAtLogin,
      click: i => app.setLoginItemSettings({ openAtLogin: i.checked, args: ["--hidden"] }) },
    { label: "Open logs folder", click: actions.openLogs },
    { type: "separator" },
    { label: "Quit", click: () => { app.isQuitting = true; app.quit(); } }
  ]);
  tray.setContextMenu(menu());
  tray.on("click", () => { const w = getWin(); w.isVisible() ? w.focus() : w.show(); });
  tray.on("right-click", () => tray.setContextMenu(menu()));
  return tray;
}
module.exports = { setupLogging, setupCrashSafety, findChrome, setupTray };
