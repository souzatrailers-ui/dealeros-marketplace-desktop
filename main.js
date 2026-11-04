// DealerOS Marketplace (Windows desktop, Electron). Original code; not affiliated with fbMarkett.
// Flow: sign in with DealerOS username/password (+2FA) -> "Connect Facebook" opens this rep's own
// persistent Chrome profile at facebook.com/login -> queue for this rep only -> automatic posting
// (pilot), take-down of sold units every few minutes, read-only lead capture every N minutes.
const { app, BrowserWindow, ipcMain, Notification, safeStorage, Tray, Menu, nativeImage, shell, dialog } = require("electron");
const { setupLogging, setupCrashSafety, findChrome, setupTray, loginItem } = require("./src/platform");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { DealerOSApi, MockApi, sessionWithProfile, SIGN_IN } = require("./src/api");
const { appWindowTitle } = require("./src/app-title");
const { Poster } = require("./src/poster");
const { Scheduler } = require("./src/scheduler");
const { AssistPoster } = require("./src/assist");
const assistants = new Map();   // rep id -> AssistPoster (own browser profile per rep and per channel)
const assistFor = r => { if (!assistants.has(r.id)) assistants.set(r.id, new AssistPoster({ repChromeDir: store.chromeDir(r.id), executablePath: findChrome() || undefined, log: m => r.log(m) })); return assistants.get(r.id); };
const ASSIST_CHANNELS = ["craigslist", "offerup"];

const DEFAULTS = {
  mock: false, apiBase: "https://app.dealerosai.ai",
  // Mock mode only: the dealership's PUBLIC inventory feed (set per dealer in the FBMP Settings tab).
  mockInventoryUrl: "", mockAssetBase: "",
  fbBase: "https://www.facebook.com", location: "",
  dailyCap: 5, minGapMin: 3, maxGapMin: 10, startHour: 9, endHour: 18,
  // "Full auto" defaults: automatic post + publish + take-down on sold. Caps, gaps, hours and checkpoint stop still apply.
  autoPost: true, autoPublish: true, delistPollMin: 3, leadPollMin: 10, staggerHours: 24, repName: "", repPhone: "",
  renewMethod: "REPOST_EVERY_N_DAYS", renewEveryDays: 7, repostEveryDays: 7, maxRenewals: 4,
  postWithoutPrice: false, repostWithoutPrice: false, specialPricing: false, removeSold: true,
  postToGroups: false, groups: [], maxGroupsPerListing: 5, maxGroupSharesPerDay: 15,
  unknownMake: "HOLD", generateDescriptionIfMissing: true, hideVehicleDetails: false,
};
// Same name on every OS: %APPDATA%\DealerOS Marketplace (Windows), ~/Library/Application Support/DealerOS Marketplace (macOS).
app.setName("DealerOS Marketplace");
app.setPath("userData", path.join(app.getPath("appData"), "DealerOS Marketplace"));
const userData = () => app.getPath("userData");
const { ProfileStore, PostingGate } = require("./src/profiles");
// 1.0.9: one isolated profile per rep (own DealerOS session, settings, logs, Chrome/Facebook folder).
let store = null;
const gate = new PostingGate({ switchGapMs: 6 * 60000 });   // several minutes between different reps' accounts

// Tokens: encrypted with Electron safeStorage (Windows DPAPI / macOS Keychain). Never plaintext.
class Rep {
  constructor(id) { this.id = id; this.api = this.poster = this.scheduler = this.leadTimer = null; this.cfg = this.loadCfg(); this.session = this.loadSession(); }
  get name() { return store.get(this.id)?.name || this.id; }
  file(f) { return path.join(store.dir(this.id), f); }
  loadCfg() { try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(this.file("settings.json"), "utf8")) }; } catch { return { ...DEFAULTS }; } }
  saveCfg() { fs.mkdirSync(store.dir(this.id), { recursive: true }); fs.writeFileSync(this.file("settings.json"), JSON.stringify(this.cfg, null, 1)); }
  saveSession(s) {
    if (!s) { fs.rmSync(this.file("session.bin"), { force: true }); return; }
    if (!safeStorage.isEncryptionAvailable()) return;
    fs.writeFileSync(this.file("session.bin"), safeStorage.encryptString(JSON.stringify(s)));
  }
  loadSession() { try { return safeStorage.isEncryptionAvailable() ? JSON.parse(safeStorage.decryptString(fs.readFileSync(this.file("session.bin")))) : null; } catch { return null; } }
  log(m) {
    console.log(`[app][${this.name}] ${m}`);
    try { const d = store.logsDir(this.id); fs.mkdirSync(d, { recursive: true });
      fs.appendFileSync(path.join(d, `dealeros-marketplace-${new Date().toISOString().slice(0, 10)}.log`), `${new Date().toISOString()} ${m}\n`); } catch {}
    if (this.id === store.active) send("log", m);
  }
  key() { return this.session?.user ? `u${this.session.user.id}-o${this.session.organization_id}` : "mock"; }
  async build() {
    await this.stop(); const cfg = this.cfg, log = m => this.log(m);
    this.api = cfg.mock ? new MockApi({ dataDir: store.dir(this.id), settings: cfg, accountId: "mock", rep: { name: cfg.repName, phone: cfg.repPhone } })
      : new DealerOSApi({ apiBase: cfg.apiBase, session: this.session,
        clientInfo: () => ({ app_version: app.getVersion(), platform: process.platform, profile: this.name }), onTokens: s => { this.session = sessionWithProfile(s, this.session); this.saveSession(this.session); } });
    this.poster = new Poster({ profilesDir: store.chromeDir(this.id), accountId: this.key(), fbBase: cfg.fbBase, log, imageDHash, assetBase: cfg.mock ? cfg.mockAssetBase : cfg.apiBase,
      executablePath: findChrome() || undefined });
    if (!(cfg.mock || (this.session?.facebook_accounts || []).length > 0)) return;
    this.scheduler = new Scheduler({ account: { id: this.id }, api: this.api, poster: this.poster, settings: cfg, gate, onEvent: (ev, ...a) => {
      if (ev === "auth-expired") { this.signOut(false, SIGN_IN).catch(() => {}); return; }
      if (this.id === store.active) send("event", ev, a);
      if (!["changed", "plan"].includes(ev)) this.log(`[event] ${ev} ${JSON.stringify(a.map(x => x && x.id ? { id: x.id, title: x.payload?.title } : x))}`);
      if (ev === "paused") new Notification({ title: `DealerOS Marketplace paused (${this.name})`, body: String(a[0]) }).show();
    } });
    this.scheduler.start();
    this.leadTimer = setInterval(() => this.pollLeads(), Math.max(5, cfg.leadPollMin) * 60000);
  }
  stop() {
    this.scheduler?.stop(); clearInterval(this.leadTimer); this.scheduler = null; this.leadTimer = null;
    const poster = this.poster; this.poster = null; gate.forget(this.id);
    return poster ? poster.close() : Promise.resolve();
  }
  async pollLeads() {
    if (!this.poster || this.leadRunning || this.scheduler?.busy || this.scheduler?.running || this.scheduler?.paused) return;   // no overlapping lead polls
    const h = new Date().getHours(); if (h < 7 || h >= 22) return;
    const run = async () => {
      this.leadRunning = true;
      try {
        // Read inside the shared Chrome window. Do not close it — the next selling-page check would open another.
        const { threads, checkpoint } = await this.poster.readLeadThreads({ inboxUrl: this.cfg.mockInboxUrl });
        if (checkpoint) { this.scheduler && (this.scheduler.paused = checkpoint); if (this.id === store.active) send("event", "paused", [checkpoint]); return; }
        if (threads.length) { const r = await this.api.postLeads(threads); this.log(`📥 ${threads.length} buyer thread(s) synced to DealerOS`); if (this.id === store.active) send("leads", r); }
      } catch (e) { this.log("⚠ lead sync: " + e.message); if (e.signOut || e.status === 401) await this.signOut(false, SIGN_IN); }
      finally { this.leadRunning = false; }
    };
    if (this.scheduler) return this.scheduler.gated(run);
    if (!gate.tryAcquire(this.id)) return false;
    try { await run(); }
    finally { try { await this.poster?.enforcePageCap?.(); } catch {} gate.release(this.id); }
  }
  async signOut(wipeFacebook, reason) {
    if (this._signingOut) return;
    this._signingOut = true;
    try {
      if (this.api?.logout) await this.api.logout();
      if (wipeFacebook && this.poster) { try { if (this.api?.fbDisconnect) await this.api.fbDisconnect(); } catch {} await this.poster.wipeProfile(); }
      await this.stop();
      this.api = null;
      this.session = null;
      this.signInReason = reason || "";
      this.saveSession(null);
      if (this.id === store.active) send("auth", null);
    } finally { this._signingOut = false; }
  }
  async start() {
    if (!(this.session || this.cfg.mock)) return;
    await this.build();
    if (!this.cfg.mock) try {
      // me() may refresh. Read api.session only after that await. Writing
      // `{ ...this.session, ...(await this.api.me()) }` copies the expired
      // tokens first, then saves them back over the new pair and leaves the
      // Account tab showing a name the server will not accept.
      const profile = await this.api.me();
      this.session = sessionWithProfile(this.api.session, profile);
      this.signInReason = "";
      this.saveSession(this.session);
      await this.build();
    } catch (e) { if (e.signOut || e.status === 401) await this.signOut(false, SIGN_IN); }
  }
}
const reps = new Map();
const cur = () => reps.get(store.active);

let win;
const send = (ch, ...a) => win?.webContents.send(ch, ...a);

/** 9x8 grayscale difference hash (same layout as the reference hashes in poster.js). */
function imageDHash(buf) {
  const img = nativeImage.createFromBuffer(buf); if (img.isEmpty()) return null;
  const bmp = img.resize({ width: 9, height: 8, quality: "good" }).toBitmap();   // BGRA
  const g = i => 0.299 * bmp[i * 4 + 2] + 0.587 * bmp[i * 4 + 1] + 0.114 * bmp[i * 4];
  let v = 0n; for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) v = (v << 1n) | (g(r * 9 + c) > g(r * 9 + c + 1) ? 1n : 0n);
  return v;
}

// ---- single instance, logs, crash safety ----
if (!app.requestSingleInstanceLock()) { app.quit(); }
app.on("second-instance", (_e, argv) => { if (win) { win.show(); win.focus(); }
  const link = (argv || []).find(a => String(a).startsWith("dealeros://")); if (link) send("deeplink", link); });
// dealeros://connect/<channel> from Settings > Connect Accounts opens the Channels tab for that channel.
try { app.setAsDefaultProtocolClient("dealeros"); } catch {}
app.on("open-url", (e, url) => { e.preventDefault(); send("deeplink", url); });
let logsInfo = null, tray = null;
try { logsInfo = setupLogging(app); } catch (e) { console.warn("logging", e); }
setupCrashSafety(app, () => win);

app.whenReady().then(async () => {
  store = new ProfileStore(userData()).load();
  for (const p of store.list()) reps.set(p.id, new Rep(p.id));
  win = new BrowserWindow({ title: appWindowTitle(app.getVersion()), width: 1200, height: 820, show: !(process.argv.includes("--hidden") || app.getLoginItemSettings().wasOpenedAsHidden), icon: path.join(__dirname, "build", "icon.png"),
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, sandbox: true } });
  // The page's <title> would replace this with the unversioned name. Keep the running version.
  win.on("page-title-updated", e => e.preventDefault());
  win.loadFile("renderer/index.html");
  // 1.0.10: renderer problems go to the app log file.
  win.webContents.on("console-message", (_e, level, message, line, sourceId) => { if (level >= 2) console.error(`renderer console: ${message} (${sourceId}:${line})`); });
  win.webContents.on("preload-error", (_e, p, err) => console.error("preload error", p, err));
  win.webContents.on("did-fail-load", (_e, code, desc, url) => console.error("renderer did-fail-load", code, desc, url));
  win.webContents.on("unresponsive", () => console.error("renderer unresponsive"));
  const ext = u => { if (/^https:\/\/(www\.)?facebook\.com\//.test(u)) shell.openExternal(u); };
  win.webContents.setWindowOpenHandler(({ url }) => { ext(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (e, url) => { if (!url.startsWith("file:")) { e.preventDefault(); ext(url); } });
  win.on("close", e => { if (!app.isQuitting) { e.preventDefault(); win.hide(); } });   // keep running in the tray
  tray = setupTray(app, { Tray, Menu, nativeImage }, path.join(__dirname, "build", process.platform === "darwin" ? "trayTemplate.png" : "tray.png"), () => win,
    { pollLeads: () => cur()?.pollLeads(), openLogs: () => logsInfo && shell.openPath(logsInfo.dir) });
  if (process.platform === "darwin" && app.dock) app.dock.hide();   // menu-bar app; window opens from the tray icon
  if ((process.platform === "win32" || process.platform === "darwin") && !findChrome()) {
    dialog.showMessageBox({ type: "warning", title: "Google Chrome required",
      message: "DealerOS Marketplace uses Google Chrome for your Facebook window.",
      detail: "Install Chrome from https://www.google.com/chrome/ and then restart DealerOS Marketplace.\n\nO DealerOS Marketplace usa o Google Chrome. Instale o Chrome e abra o aplicativo novamente.",
      buttons: ["Download Chrome", "Later"] }).then(r => { if (r.response === 0) shell.openExternal("https://www.google.com/chrome/"); });
  }
  for (const r of reps.values()) await r.start();     // every signed-in rep's scheduler runs; the gate serializes them
  // Auto-update from GitHub releases (souzatrailers-ui/dealeros-marketplace-desktop). Checks at start + every 4h.
  // Unsigned builds must not require publisherName; that check is baked in at build time (src/win-update.js).
  try {
    const { autoUpdater } = require("electron-updater");
    const { configureWindowsUpdater } = require("./src/win-update");
    const check = configureWindowsUpdater(autoUpdater, {
      log: m => console.warn(m),
      notify: n => new Notification({ title: n.title, body: n.body }).show(),
    });
    if (app.isPackaged) { check(); setInterval(check, 4 * 3600 * 1000); }
  } catch (e) { console.warn("updater", e.message); }
  // Unsigned Mac builds can't self-install updates: show a "new version available" notice instead.
  if (process.platform === "darwin" && app.isPackaged) {
    const { checkLatest } = require("./src/update-check");
    let told = "";
    const macCheck = () => checkLatest(app.getVersion()).then(u => {
      if (!u.newer || told === u.version) return; told = u.version;
      const n = new Notification({ title: "DealerOS Marketplace update available", body: `Version ${u.version} is out. Click to download it (DealerOS › Marketplace › Get the app).` });
      n.on("click", () => shell.openExternal(u.url)); n.show();
    }).catch(e => console.warn("mac update check", e.message));
    macCheck(); setInterval(macCheck, 4 * 3600 * 1000);
  }
});
app.on("before-quit", (e) => {
  if (app.isQuitting) return;
  app.isQuitting = true;
  e.preventDefault();   // finish closing each rep's Chrome (Mac often ignores a dropped Playwright handle)
  const jobs = [...reps.values()].map(r => Promise.resolve(r.stop()).catch(() => {}));
  Promise.race([Promise.all(jobs), new Promise(r => setTimeout(r, 5000))]).finally(() => app.exit(0));
});
app.on("window-all-closed", () => { /* stay in tray */ });

const pub = () => { const session = cur().session; return session ? { user: session.user, organization_id: session.organization_id, facebook_accounts: session.facebook_accounts || [] } : null; };
const profilesView = () => ({ active: store.active, gate: gate.status(), profiles: store.list().map(p => { const r = reps.get(p.id), u = r?.session?.user;
  return { id: p.id, name: p.name, user: u ? (u.full_name || u.username) : null, facebook: (r?.session?.facebook_accounts || [])[0]?.label || null, running: !!r?.scheduler, busy: !!r?.scheduler?.busy, paused: r?.scheduler?.paused || null }; }) });
ipcMain.on("renderer:error", (_e, m) => console.error("renderer error:", String(m)));
ipcMain.handle("profiles:list", () => profilesView());
ipcMain.handle("profiles:add", (_, name) => { const id = store.add(name); reps.set(id, new Rep(id)); store.setActive(id); send("auth", null); return profilesView(); });
ipcMain.handle("profiles:switch", (_, id) => { store.setActive(id); send("auth", pub()); return profilesView(); });   // UI view only; every rep keeps running
ipcMain.handle("profiles:rename", (_, id, name) => { store.rename(id, name); return profilesView(); });
ipcMain.handle("profiles:remove", async (_, id) => {
  const r = reps.get(id); if (store.list().length <= 1) return { error: "Can't remove the last profile" };
  if (r?.scheduler?.busy) return { error: "That profile is posting right now; try again in a minute" };
  if (r) { try { if (r.api?.logout) await r.api.logout(); } catch {} await r.stop(); reps.delete(id); }
  store.remove(id); return profilesView();
});
ipcMain.handle("auth:get", () => ({ session: pub(), mock: cur().cfg.mock, apiBase: cur().cfg.apiBase, encryption: safeStorage.isEncryptionAvailable(), profile: store.active, signInReason: cur().signInReason || "" }));
ipcMain.handle("auth:login", async (_, { apiBase, username, password, mfa_code, organization_id }) => {
  const r = cur(); r.cfg.apiBase = apiBase || DEFAULTS.apiBase; r.cfg.mock = false; r.saveCfg();
  try {
    const s = await DealerOSApi.login(r.cfg.apiBase, { username, password, mfa_code, organization_id, device_name: os.hostname() });
    const dup = [...reps.values()].find(o => o !== r && o.session?.user && o.session.user.id === s.user?.id && o.session.organization_id === s.organization_id);
    if (dup) { try { await new DealerOSApi({ apiBase: r.cfg.apiBase, session: s }).logout(); } catch {} return { ok: false, error: `That DealerOS user is already signed in on profile "${dup.name}"` }; }
    r.session = s; r.signInReason = ""; r.saveSession(s); await r.build(); return { ok: true, session: pub() };
  } catch (e) {
    let orgs = null; try { orgs = JSON.parse(e.message).choose_organization; } catch {}
    return { ok: false, status: e.status, error: orgs ? "Choose a dealership" : e.message, organizations: orgs };
  }
});
ipcMain.handle("auth:logout", (_, { wipeFacebook }) => cur().signOut(!!wipeFacebook));
ipcMain.handle("fb:connect", async () => {
  const r = cur(); if (!r.session) throw new Error("Sign in to DealerOS first");
  if (!gate.tryAcquire(r.id)) throw new Error("Another profile is using the browser right now; try again in a few minutes");
  try {
    const info = await r.poster.connectFacebook();       // rep logs in by hand in the visible window (their own Chrome folder)
    const acct = await r.api.fbConnect(info);
    const profile = await r.api.me(); r.session = sessionWithProfile(r.api.session, profile); r.saveSession(r.session); await r.build();
    return { ok: true, account: acct, session: pub() };
  } finally { gate.release(r.id); }
});
// 1.0.10: "Open Facebook Messages" - always the CURRENTLY SELECTED rep's own Chrome profile (store.chromeDir(rep.id)).
ipcMain.handle("fb:openMessages", async (_, where) => {
  const r = cur(); if (!r) return { error: "No rep profile selected" };
  if (!r.poster) return { error: `Sign in to DealerOS and connect Facebook for "${r.name}" first`, fallback: "https://www.facebook.com/messages/" };
  try { return { ...(await r.poster.openMessages(r.cfg.fbBase, where === "messages" ? "messages" : "inbox")), rep: r.name }; }
  catch (e) { console.error("openMessages", r.id, e); return { error: "Couldn't open Facebook: " + String(e.message || e).split("\n")[0], fallback: "https://www.facebook.com/messages/" }; }
});
// ---- Phase 2 assisted channels: the rep signs in by hand and clicks Publish themselves ----
ipcMain.handle("assist:connect", async (_, channel) => {
  if (!ASSIST_CHANNELS.includes(channel)) return { error: "Unknown channel" };
  const r = cur(); const name = await assistFor(r).connect(channel);
  if (!name) return { error: "Not signed in yet. Sign in inside the window that opened, then try again." };
  await r.api.channelConnected(channel, name); r.log(`[assist] ${channel} connected for this rep`); return { ok: true, name };
});
ipcMain.handle("assist:disconnect", async (_, channel) => ASSIST_CHANNELS.includes(channel) && cur().api.channelDisconnected(channel));
ipcMain.handle("assist:tasks", () => cur().api.assistTasks ? cur().api.assistTasks() : { tasks: [] });
ipcMain.handle("assist:open", async (_, task) => {
  const r = cur(); await r.api.assistReport(task.id, "opened");
  const res = await assistFor(r).assist(task.channel, task.payload);
  if (res.published) { await r.api.assistReport(task.id, "published", res.url); r.log(`[assist] ${task.channel} published by rep: ${res.url}`); }
  return res;
});
ipcMain.handle("assist:skip", (_, id) => cur().api.assistReport(id, "skipped"));
ipcMain.handle("cfg:get", () => cur().cfg);
ipcMain.handle("cfg:save", async (_, patch) => { const r = cur(); r.cfg = { ...r.cfg, ...patch }; r.saveCfg(); await r.build(); return true; });
async function callApi(fn) {
  const r = cur();
  if (!r?.api) {
    if (r) await r.signOut(false, SIGN_IN);
    throw Object.assign(new Error(SIGN_IN), { signIn: true });
  }
  try { return await fn(r); }
  catch (e) {
    if (e && (e.signOut || e.status === 401)) {
      await r.signOut(false, SIGN_IN);
      throw Object.assign(new Error(SIGN_IN), { signIn: true });
    }
    throw e;
  }
}
ipcMain.handle("queue:state", () => callApi(r => r.api.state()));
ipcMain.handle("queue:approve", (_, jobId) => cur().api.approve ? cur().api.approve(jobId) : null);
ipcMain.handle("queue:runNow", async () => { const s = cur().scheduler; if (!s) return { error: "Connect Facebook first" };
  return (await s.gated(() => s.runOnce())) ? true : { error: "Another profile is posting (or the switch gap is running); try again in a few minutes" }; });
ipcMain.handle("app:openUrl", (_, u) => /^https:\/\/www\.facebook\.com\//.test(String(u)) && shell.openExternal(u));
ipcMain.handle("queue:auto", (_, on) => { const s = cur().scheduler; if (!s) return false; on ? s.start() : s.stop(); return on; });
ipcMain.handle("queue:resume", () => { const s = cur().scheduler; if (s) s.paused = null; return true; });
ipcMain.handle("queue:report", (_, jobId, r) => cur().api.report(jobId, r));
ipcMain.handle("leads:pollNow", () => cur().pollLeads());
ipcMain.handle("app:info", () => ({ version: app.getVersion(), title: appWindowTitle(app.getVersion()), logs: store ? store.logsDir(store.active) : logsInfo?.dir, chrome: findChrome(), startWithWindows: app.getLoginItemSettings().openAtLogin }));
ipcMain.handle("app:startWithWindows", (_, on) => { app.setLoginItemSettings(loginItem(!!on)); return !!on; });
ipcMain.handle("app:openLogs", () => { const d = store.logsDir(store.active); fs.mkdirSync(d, { recursive: true }); return shell.openPath(d); });
// Groups come from the dealer's own list in DealerOS (no dealer data is bundled in the app).
ipcMain.handle("groups:list", async () => {
  try { return ((await callApi(r => r.api.state())).profile || {}).groups || []; }
  catch (e) { if (e && e.signIn) throw e; return []; }
});
ipcMain.handle("groups:import", async () => {
  const r = cur(); if (!r.poster || !r.api?.importGroups) return { error: "Sign in and connect Facebook first" };
  if (!gate.tryAcquire(r.id)) return { error: "Another profile is using the browser right now; try again in a few minutes" };
  try { const groups = await r.poster.readJoinedGroups(); return r.api.importGroups(groups); } finally { gate.release(r.id); }
});
