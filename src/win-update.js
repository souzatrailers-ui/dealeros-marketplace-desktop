/** Windows update behavior for unsigned builds, and for builds signed with CSC_LINK.
 *  publisherName is copied into the installed app's app-update.yml. electron-updater
 *  then rejects any downloaded exe that is not signed by that name. Until a
 *  certificate exists, leave the name off and turn the check off. */

const PUBLISHER_NAME = "DealerOS AI";

function signingConfigured(env = process.env) {
  return ["CSC_LINK", "WIN_CSC_LINK"].some(key => String(env[key] || "").trim() !== "");
}

function windowsSigning(env = process.env) {
  if (signingConfigured(env)) {
    return {
      verifyUpdateCodeSignature: true,
      signtoolOptions: { publisherName: PUBLISHER_NAME },
    };
  }
  return { verifyUpdateCodeSignature: false };
}

function electronBuilderConfig(env = process.env) {
  const base = JSON.parse(JSON.stringify(require("../package.json").build));
  const win = { ...(base.win || {}) };
  delete win.signtoolOptions;
  delete win.publisherName;
  return { ...base, win: { ...win, ...windowsSigning(env) } };
}

function updaterFailure(e) {
  if (e instanceof Error) return "updater failed: " + (e.stack || e.message);
  return "updater failed: " + String(e == null ? "unknown error" : e);
}

/** Wire electron-updater so a failed download is logged and the promise is handled.
 *  The new installer is installed the next time the app quits. */
function configureWindowsUpdater(autoUpdater, { log, notify } = {}) {
  const write = typeof log === "function" ? log : () => {};
  const tell = typeof notify === "function" ? notify : () => {};
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.disableWebInstaller = true;
  const line = level => (...args) => write("updater " + level + ": " + args.map(a => (a instanceof Error ? (a.stack || a.message) : String(a))).join(" "));
  autoUpdater.logger = { info: line("info"), warn: line("warn"), error: line("error"), debug: line("debug") };
  autoUpdater.on("error", (e, message) => write(updaterFailure(message || e)));
  autoUpdater.on("update-downloaded", info => {
    const version = info && info.version ? info.version : "";
    write("updater: " + (version || "update") + " downloaded. It installs when you quit the app.");
    tell({
      title: "Update downloaded",
      body: version ? `Restart DealerOS Marketplace to install version ${version}.` : "Restart DealerOS Marketplace to install the update.",
    });
  });
  return function checkForUpdates() {
    return Promise.resolve()
      .then(() => autoUpdater.checkForUpdates())
      .then(result => {
        const download = result && result.downloadPromise;
        if (download && typeof download.then === "function") return download.then(() => undefined, e => write(updaterFailure(e)));
      })
      .catch(e => write(updaterFailure(e)));
  };
}

module.exports = { PUBLISHER_NAME, signingConfigured, windowsSigning, electronBuilderConfig, updaterFailure, configureWindowsUpdater };
