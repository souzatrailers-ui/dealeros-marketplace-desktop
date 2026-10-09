const { contextBridge, ipcRenderer } = require("electron");
const inv = (c, ...a) => ipcRenderer.invoke(c, ...a);
contextBridge.exposeInMainWorld("dealeros", {
  auth: () => inv("auth:get"), login: creds => inv("auth:login", creds), logout: wipeFacebook => inv("auth:logout", { wipeFacebook }),
  connectFacebook: () => inv("fb:connect"),
  getCfg: () => inv("cfg:get"), saveCfg: p => inv("cfg:save", p),
  state: () => inv("queue:state"), approve: j => inv("queue:approve", j), runNow: () => inv("queue:runNow"),
  auto: on => inv("queue:auto", on), resume: () => inv("queue:resume"), report: (j, r) => inv("queue:report", j, r),
  pollLeads: () => inv("leads:pollNow"), appInfo: () => inv("app:info"), startWithWindows: on => inv("app:startWithWindows", on), openLogs: () => inv("app:openLogs"), groups: () => inv("groups:list"),
  onLog: f => ipcRenderer.on("log", (_, m) => f(m)), onEvent: f => ipcRenderer.on("event", (_, ev, a) => f(ev, a)),
  onAuth: f => ipcRenderer.on("auth", (_, s) => f(s)), onLeads: f => ipcRenderer.on("leads", (_, r) => f(r))
});
