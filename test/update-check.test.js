const test = require("node:test"); const assert = require("node:assert");
const { isNewer, checkLatest } = require("../src/update-check");
test("version compare", () => {
  assert.ok(isNewer("1.0.13", "1.0.12")); assert.ok(isNewer("v1.1.0", "1.0.99")); assert.ok(isNewer("marketplace-v2.0.0", "1.9.9"));
  assert.ok(!isNewer("1.0.12", "1.0.12")); assert.ok(!isNewer("1.0.11", "1.0.12"));
});
test("checkLatest reads the GitHub latest release", async () => {
  const fake = async () => ({ ok: true, json: async () => ({ tag_name: "v1.0.13", html_url: "https://gh/rel" }) });
  assert.deepStrictEqual(await checkLatest("1.0.12", fake), { version: "1.0.13", url: "https://gh/rel", newer: true });
  await assert.rejects(checkLatest("1.0.12", async () => ({ ok: false, status: 403 })));
});
