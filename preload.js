const { contextBridge, ipcRenderer } = require("electron");
const inv = (c, ...a) => ipcRenderer.invoke(c, ...a);
contextBridge.exposeInMainWorld("dealeros", {
  auth: () => inv("auth:get"), login: creds => inv("auth:login", creds), logout: wipeFacebook => inv("auth:logout", { wipeFacebook }),
  connectFacebook: () => inv("fb:connect"), openMessages: where => inv("fb:openMessages", where),
  getCfg: () => inv("cfg:get"), saveCfg: p => inv("cfg:save", p),
  state: () => inv("queue:state"), approve: j => inv("queue:approve", j), runNow: () => inv("queue:runNow"),
  auto: on => inv("queue:auto", on), resume: () => inv("queue:resume"), report: (j, r) => inv("queue:report", j, r),
  logError: m => ipcRenderer.send("renderer:error", String(m).slice(0, 8000)), pollLeads: () => inv("leads:pollNow"), appInfo: () => inv("app:info"), startWithWindows: on => inv("app:startWithWindows", on), openLogs: () => inv("app:openLogs"), openUrl: u => inv("app:openUrl", u), groups: () => inv("groups:list"), importGroups: () => inv("groups:import"),
  profiles: () => inv("profiles:list"), addProfile: n => inv("profiles:add", n), switchProfile: id => inv("profiles:switch", id),
  renameProfile: (id, n) => inv("profiles:rename", id, n), removeProfile: id => inv("profiles:remove", id),
  assistConnect: c => inv("assist:connect", c), assistDisconnect: c => inv("assist:disconnect", c), assistTasks: () => inv("assist:tasks"),
  assistOpen: t => inv("assist:open", t), assistSkip: id => inv("assist:skip", id), onDeepLink: f => ipcRenderer.on("deeplink", (_, u) => f(u)),
  onLog: f => ipcRenderer.on("log", (_, m) => f(m)), onEvent: f => ipcRenderer.on("event", (_, ev, a) => f(ev, a)),
  onAuth: f => ipcRenderer.on("auth", (_, s) => f(s)), onLeads: f => ipcRenderer.on("leads", (_, r) => f(r))
});

// 1.0.10: renderer errors (including a renderer.js that fails to parse) go to the app log, and if the
// renderer never started, show a visible message instead of a blank, unclickable window.
const report = m => { try { ipcRenderer.send("renderer:error", String(m).slice(0, 8000)); } catch {} };
window.addEventListener("error", e => report(`${e.message} @ ${e.filename}:${e.lineno}:${e.colno}${e.error && e.error.stack ? "\n" + e.error.stack : ""}`));
window.addEventListener("unhandledrejection", e => report("unhandledrejection: " + (e.reason && (e.reason.stack || e.reason.message) || e.reason)));
window.addEventListener("load", () => setTimeout(() => {
  if (document.getElementById("app-error") || document.querySelector("[data-renderer-ok]")) return;
  const main = document.getElementById("app"), login = document.getElementById("login"), conn = document.getElementById("connect");
  if ([main, login, conn].some(el => el && !el.hidden)) return;      // a screen is showing: renderer is alive
  const b = document.createElement("div"); b.id = "app-error";
  b.style.cssText = "background:#fee2e2;color:#991b1b;padding:12px;font:14px system-ui;white-space:pre-wrap";
  b.textContent = "⚠ DealerOS Marketplace could not start its screen. Please restart the app; if this keeps happening, send the log file (tray icon → Open logs folder) to DealerOS support.";
  document.body.appendChild(b); report("renderer did not show any screen within 8s of load");
}, 8000));
