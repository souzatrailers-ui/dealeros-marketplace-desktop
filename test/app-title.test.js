const test = require("node:test"), assert = require("node:assert");
const fs = require("fs"), path = require("path");
const { appWindowTitle } = require("../src/app-title");

const root = path.join(__dirname, "..");
const read = name => fs.readFileSync(path.join(root, name), "utf8");

test("the window title shows the running version", () => {
  assert.equal(appWindowTitle("1.0.16"), "DealerOS Marketplace v1.0.16");
  assert.equal(appWindowTitle(" 1.0.16 "), "DealerOS Marketplace v1.0.16");
  assert.equal(appWindowTitle(""), "DealerOS Marketplace");
  assert.equal(appWindowTitle(null), "DealerOS Marketplace");
});

test("package.json is 1.0.18 and the window and header use that title", () => {
  const pkg = require("../package.json");
  assert.equal(pkg.version, "1.0.18");
  assert.equal(appWindowTitle(pkg.version), "DealerOS Marketplace v1.0.18");
  const main = read("main.js");
  const renderer = read("renderer/renderer.js");
  const html = read("renderer/index.html");
  assert.match(main, /new BrowserWindow\(\{ title: appWindowTitle\(app\.getVersion\(\)\)/);
  assert.match(main, /page-title-updated/);
  assert.match(main, /title: appWindowTitle\(app\.getVersion\(\)\)/);
  assert.match(html, /id="app-name"/);
  assert.match(renderer, /document\.title\s*=\s*i\.title/);
  assert.match(renderer, /\$\("app-name"\)/);
  assert.match(renderer, /name\.textContent\s*=\s*i\.title/);
});
