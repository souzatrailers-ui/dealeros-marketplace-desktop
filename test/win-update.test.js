const test = require("node:test"), assert = require("node:assert");
const fs = require("fs"), path = require("path");
const { windowsSigning, electronBuilderConfig, configureWindowsUpdater, PUBLISHER_NAME } = require("../src/win-update");

const root = path.join(__dirname, "..");
const pkg = require("../package.json");

test("an unsigned Windows build does not demand a publisher signature", () => {
  const win = windowsSigning({});
  assert.equal(win.verifyUpdateCodeSignature, false);
  assert.equal(win.signtoolOptions, undefined);
  assert.equal(windowsSigning({ CSC_LINK: "  " }).verifyUpdateCodeSignature, false);
  const config = electronBuilderConfig({});
  assert.equal(config.win.verifyUpdateCodeSignature, false);
  assert.equal(config.win.signtoolOptions, undefined);
  assert.equal(config.win.publisherName, undefined);
  assert.equal(pkg.version, "1.0.18");
  assert.equal(pkg.build.win.verifyUpdateCodeSignature, false);
  assert.equal(pkg.build.win.signtoolOptions, undefined);
  assert.match(pkg.scripts["dist:win"], /--config electron-builder\.config\.js/);
  assert.match(pkg.scripts["release:win"], /--config electron-builder\.config\.js/);
  const releasing = fs.readFileSync(path.join(root, "RELEASING.md"), "utf8");
  assert.doesNotMatch(releasing, /stamp-exe/);
  assert.match(releasing, /CSC_LINK/);
  assert.match(releasing, /verifyUpdateCodeSignature/);
});

test("CSC_LINK keeps the publisher check", () => {
  for (const env of [{ CSC_LINK: "https://certs.example/dealer.pfx" }, { WIN_CSC_LINK: "/tmp/dealer.pfx" }]) {
    const win = windowsSigning(env);
    assert.equal(win.verifyUpdateCodeSignature, true);
    assert.equal(win.signtoolOptions.publisherName, PUBLISHER_NAME);
    const config = electronBuilderConfig(env);
    assert.equal(config.win.verifyUpdateCodeSignature, true);
    assert.equal(config.win.signtoolOptions.publisherName, "DealerOS AI");
    assert.equal(config.appId, pkg.build.appId);
  }
});

function fakeUpdater() {
  const handlers = {};
  return {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    disableWebInstaller: false,
    logger: null,
    handlers,
    on(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); },
    emit(ev, ...args) { for (const fn of handlers[ev] || []) fn(...args); },
    checkForUpdates: async () => ({ downloadPromise: Promise.resolve() }),
  };
}

test("a rejected download is logged and does not reject the check", async () => {
  const logs = [];
  const updater = fakeUpdater();
  updater.checkForUpdates = async () => ({ downloadPromise: Promise.reject(new Error("New version 1.0.14 is not signed by the application owner")) });
  const check = configureWindowsUpdater(updater, { log: m => logs.push(m) });
  assert.equal(updater.disableWebInstaller, true);
  assert.equal(updater.autoInstallOnAppQuit, true);
  assert.equal(updater.autoDownload, true);
  await check();
  assert.ok(logs.some(line => /not signed by the application owner/.test(line)));
  updater.emit("error", new Error("temp exe is not digitally signed"));
  assert.ok(logs.some(line => /not digitally signed/.test(line)));
});

test("a finished download asks for a restart and installs on quit", async () => {
  const logs = [];
  const notes = [];
  const updater = fakeUpdater();
  updater.checkForUpdates = async () => {
    updater.emit("update-downloaded", { version: "1.0.18" });
    return { downloadPromise: Promise.resolve(["installer.exe"]) };
  };
  const check = configureWindowsUpdater(updater, { log: m => logs.push(m), notify: n => notes.push(n) });
  await check();
  assert.equal(notes.length, 1);
  assert.equal(notes[0].title, "Update downloaded");
  assert.match(notes[0].body, /Restart DealerOS Marketplace to install version 1\.0\.18/);
  assert.ok(logs.some(line => /1\.0\.18 downloaded/.test(line)));
  updater.logger.error("Cannot download differentially, fallback to full download: 404 blockmap");
  assert.ok(logs.some(line => /404 blockmap/.test(line) && line.startsWith("updater error:")));
});
