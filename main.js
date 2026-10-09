// DealerOS Marketplace (Windows desktop, Electron). Original code; not affiliated with fbMarkett.
// Flow: sign in with DealerOS username/password (+2FA) -> "Connect Facebook" opens this rep's own
// persistent Chrome profile at facebook.com/login -> queue for this rep only -> automatic posting
// (pilot), take-down of sold units every few minutes, read-only lead capture every N minutes.
const { app, BrowserWindow, ipcMain, Notification, safeStorage, Tray, Menu, nativeImage, shell, dialog } = require("electron");
const { setupLogging, setupCrashSafety, findChrome, setupTray } = require("./src/platform");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { DealerOSApi, MockApi } = require("./src/api");
const { Poster } = require("./src/poster");
const { Scheduler } = require("./src/scheduler");

const DEFAULTS = {
  mock: false, apiBase: "https://app.dealerosai.ai",
  mockInventoryUrl: "https://swtct.com/api/public/dealers/souza-wholesale-trailers/inventory", mockAssetBase: "https://swtct.com",
  fbBase: "https://www.facebook.com", form: "vehicle", location: "",
  dailyCap: 5, minGapMin: 3, maxGapMin: 10, startHour: 9, endHour: 18,
  // Souza pilot defaults (Samuel 2026-10-09): automatic post + publish + take-down on sold. ONE rep first.
  autoPost: true, autoPublish: true, delistPollMin: 3, leadPollMin: 10, staggerHours: 24, repName: "", repPhone: "",
  renewMethod: "REPOST_EVERY_N_DAYS", renewEveryDays: 7, repostEveryDays: 7, maxRenewals: 4,
  postWithoutPrice: false, repostWithoutPrice: false, specialPricing: false, removeSold: true,
  postToGroups: false, groups: [], maxGroupsPerListing: 5, maxGroupSharesPerDay: 15,
  unknownMake: "OTHER", generateDescriptionIfMissing: true, hideVehicleDetails: false,
};
const userData = () => app.getPath("userData");
const cfgFile = () => path.join(userData(), "settings.json");
const sessFile = () => path.join(userData(), "session.bin");
function loadCfg() { try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(cfgFile(), "utf8")) }; } catch { return { ...DEFAULTS }; } }
function saveCfg(c) { fs.writeFileSync(cfgFile(), JSON.stringify(c, null, 1)); }

// Tokens: encrypted with Electron safeStorage (Windows DPAPI, same protection as Credential Manager).
// If OS encryption is unavailable we refuse to persist (session lives in memory only) - never plaintext.
function saveSession(s) {
  if (!s) { fs.rmSync(sessFile(), { force: true }); return; }
  if (!safeStorage.isEncryptionAvailable()) return;
  fs.writeFileSync(sessFile(), safeStorage.encryptString(JSON.stringify(s)));
}
function loadSession() {
  try { return safeStorage.isEncryptionAvailable() ? JSON.parse(safeStorage.decryptString(fs.readFileSync(sessFile()))) : null; } catch { return null; }
}

let win, cfg, session = null, api = null, poster = null, scheduler = null, leadTimer = null;
const send = (ch, ...a) => win?.webContents.send(ch, ...a);
const log = m => send("log", m);

function profileKey() { return session?.user ? `u${session.user.id}-o${session.organization_id}` : "mock"; }
function buildRuntime() {
  stopRuntime();
  api = cfg.mock ? new MockApi({ dataDir: userData(), settings: cfg, accountId: "mock", rep: { name: cfg.repName, phone: cfg.repPhone } })
    : new DealerOSApi({ apiBase: cfg.apiBase, session, onTokens: s => { session = { ...session, ...s }; saveSession(session); } });
  poster = new Poster({ profilesDir: path.join(userData(), "profiles"), accountId: profileKey(), fbBase: cfg.fbBase, log,
    executablePath: findChrome() || undefined });
  const fbConnected = cfg.mock || (session?.facebook_accounts || []).length > 0;
  if (!fbConnected) return;
  scheduler = new Scheduler({ account: { id: profileKey() }, api, poster, settings: cfg, onEvent: (ev, ...a) => {
    send("event", ev, a);
    if (ev === "paused") new Notification({ title: "DealerOS Marketplace paused", body: String(a[0]) }).show();
  } });
  scheduler.start();
  leadTimer = setInterval(pollLeads, Math.max(5, cfg.leadPollMin) * 60000);
}
function stopRuntime() { scheduler?.stop(); clearInterval(leadTimer); poster?.close(); scheduler = null; leadTimer = null; }

async function pollLeads() {
  if (!poster || scheduler?.busy || scheduler?.paused) return;
  const h = new Date().getHours(); if (h < 7 || h >= 22) return;   // reading is quieter than posting but still human-hours
  try {
    const { threads, checkpoint } = await poster.readLeadThreads({ inboxUrl: cfg.mockInboxUrl });
    if (checkpoint) { scheduler && (scheduler.paused = checkpoint); send("event", "paused", [checkpoint]); return; }
    if (threads.length) { const r = await api.postLeads(threads); log(`📥 ${threads.length} buyer thread(s) synced to DealerOS`); send("leads", r); }
  } catch (e) { log("⚠ lead sync: " + e.message); if (e.signOut) await signOut(false); }
}
async function signOut(wipeFacebook) {
  if (api?.logout) await api.logout();
  if (wipeFacebook && poster) { try { if (api?.fbDisconnect) await api.fbDisconnect(); } catch {} await poster.wipeProfile(); }
  stopRuntime(); session = null; saveSession(null); send("auth", null);
}

// ---- single instance, logs, crash safety ----
if (!app.requestSingleInstanceLock()) { app.quit(); }
app.on("second-instance", () => { if (win) { win.show(); win.focus(); } });
let logsInfo = null, tray = null;
try { logsInfo = setupLogging(app); } catch (e) { console.warn("logging", e); }
setupCrashSafety(app, () => win);

app.whenReady().then(async () => {
  cfg = loadCfg(); session = loadSession();
  win = new BrowserWindow({ width: 1200, height: 820, show: !process.argv.includes("--hidden"), icon: path.join(__dirname, "build", "icon.png"),
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, sandbox: true } });
  win.loadFile("renderer/index.html");
  win.on("close", e => { if (!app.isQuitting) { e.preventDefault(); win.hide(); } });   // keep running in the tray
  tray = setupTray(app, { Tray, Menu, nativeImage }, path.join(__dirname, "build", "tray.png"), () => win,
    { pollLeads: () => pollLeads(), openLogs: () => logsInfo && shell.openPath(logsInfo.dir) });
  if (process.platform === "win32" && !findChrome()) {
    dialog.showMessageBox({ type: "warning", title: "Google Chrome required",
      message: "DealerOS Marketplace uses Google Chrome for your Facebook window.",
      detail: "Install Chrome from https://www.google.com/chrome/ and then restart DealerOS Marketplace.\n\nO DealerOS Marketplace usa o Google Chrome. Instale o Chrome e abra o aplicativo novamente.",
      buttons: ["Download Chrome", "Later"] }).then(r => { if (r.response === 0) shell.openExternal("https://www.google.com/chrome/"); });
  }
  if (session || cfg.mock) {
    buildRuntime();
    if (!cfg.mock) try { session = { ...session, ...(await api.me()) }; saveSession(session); buildRuntime(); } catch (e) { if (e.signOut || e.status === 401) await signOut(false); }
  }
  // Auto-update from GitHub releases (souzatrailers-ui/dealeros-marketplace-desktop). Checks at start + every 4h.
  try {
    const { autoUpdater } = require("electron-updater");
    autoUpdater.logger = console; autoUpdater.autoDownload = true; autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on("update-downloaded", i => new Notification({ title: "DealerOS Marketplace update ready", body: `Version ${i.version} installs when you quit the app.` }).show());
    autoUpdater.on("error", e => console.warn("updater", e.message));
    const check = () => app.isPackaged && autoUpdater.checkForUpdates().catch(e => console.warn("updater", e.message));
    check(); setInterval(check, 4 * 3600 * 1000);
  } catch (e) { console.warn("updater", e.message); }
});
app.on("before-quit", () => { app.isQuitting = true; stopRuntime(); });
app.on("window-all-closed", () => { /* stay in tray */ });

const pub = () => session ? { user: session.user, organization_id: session.organization_id, facebook_accounts: session.facebook_accounts || [] } : null;
ipcMain.handle("auth:get", () => ({ session: pub(), mock: cfg.mock, apiBase: cfg.apiBase, encryption: safeStorage.isEncryptionAvailable() }));
ipcMain.handle("auth:login", async (_, { apiBase, username, password, mfa_code, organization_id }) => {
  cfg.apiBase = apiBase || DEFAULTS.apiBase; cfg.mock = false; saveCfg(cfg);
  try {
    const r = await DealerOSApi.login(cfg.apiBase, { username, password, mfa_code, organization_id, device_name: os.hostname() });
    session = r; saveSession(session); buildRuntime(); return { ok: true, session: pub() };
  } catch (e) {
    let orgs = null; try { orgs = JSON.parse(e.message).choose_organization; } catch {}
    return { ok: false, status: e.status, error: orgs ? "Choose a dealership" : e.message, organizations: orgs };
  }
});
ipcMain.handle("auth:logout", (_, { wipeFacebook }) => signOut(!!wipeFacebook));
ipcMain.handle("fb:connect", async () => {
  if (!session) throw new Error("Sign in to DealerOS first");
  const info = await poster.connectFacebook();       // rep logs in by hand in the visible window
  const acct = await api.fbConnect(info);
  session = { ...session, ...(await api.me()) }; saveSession(session); buildRuntime();
  return { ok: true, account: acct, session: pub() };
});
ipcMain.handle("cfg:get", () => cfg);
ipcMain.handle("cfg:save", (_, patch) => { cfg = { ...cfg, ...patch }; saveCfg(cfg); buildRuntime(); return true; });
ipcMain.handle("queue:state", () => api.state());
ipcMain.handle("queue:approve", (_, jobId) => api.approve ? api.approve(jobId) : null);
ipcMain.handle("queue:runNow", () => scheduler?.runOnce());
ipcMain.handle("queue:auto", (_, on) => { if (!scheduler) return false; on ? scheduler.start() : scheduler.stop(); return on; });
ipcMain.handle("queue:resume", () => { if (scheduler) scheduler.paused = null; return true; });
ipcMain.handle("queue:report", (_, jobId, r) => api.report(jobId, r));
ipcMain.handle("leads:pollNow", () => pollLeads());
ipcMain.handle("app:info", () => ({ version: app.getVersion(), logs: logsInfo?.dir, chrome: findChrome(), startWithWindows: app.getLoginItemSettings().openAtLogin }));
ipcMain.handle("app:startWithWindows", (_, on) => { app.setLoginItemSettings({ openAtLogin: !!on, args: ["--hidden"] }); return !!on; });
ipcMain.handle("app:openLogs", () => logsInfo && shell.openPath(logsInfo.dir));
ipcMain.handle("groups:list", () => JSON.parse(fs.readFileSync(path.join(__dirname, "groups.json"), "utf8")).groups);
