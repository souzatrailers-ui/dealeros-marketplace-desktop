// 1.0.11: Facebook's EDIT page (/marketplace/edit/?listing_id=...) must get Next (after it enables) and then Update.
// Runs against a local fake page served through Playwright routing (never touches Facebook). Needs Google Chrome.
const test = require("node:test"), assert = require("node:assert"), fs = require("fs"), os = require("os"), path = require("path");
const { chromium } = require("playwright-core");
const { Poster } = require("../src/poster");
const FC = require("../src/formcheck");
const CHROME = ["/usr/bin/google-chrome", "C:\\\\Program Files\\\\Google\\\\Chrome\\\\Application\\\\chrome.exe", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find(p => fs.existsSync(p));

test("final-button helpers", () => {
  assert.ok(FC.isEditForm("https://www.facebook.com/marketplace/edit/?listing_id=123"));
  assert.ok(!FC.isEditForm("https://www.facebook.com/marketplace/create/vehicle"));
  assert.ok(FC.isFormUrl("https://www.facebook.com/marketplace/edit/?listing_id=1") && FC.isFormUrl("https://www.facebook.com/marketplace/create/vehicle"));
  assert.ok(!FC.isFormUrl("https://www.facebook.com/marketplace/you/selling"));
  for (const b of ["Publish", "Update", "Save"]) assert.ok(FC.FINAL_BUTTONS.includes(b));
});

const page = (vt, finalLabel, withNext) => `<!doctype html><html><body>
<div role="combobox" aria-label="Vehicle type"><span>Vehicle type</span> <b>${vt}</b></div>
${withNext ? `<div role="button" id="next" aria-disabled="true" onclick="if(this.getAttribute('aria-disabled')!=='true'){document.getElementById('s2').hidden=false;this.hidden=true}">Next</div>` : ""}
<div id="s2" ${withNext ? "hidden" : ""}><div role="button" onclick="location.href='https://www.facebook.com/marketplace/you/selling'">${finalLabel}</div></div>
<script>setTimeout(()=>{const n=document.getElementById('next'); if(n) n.removeAttribute('aria-disabled')}, 9000)</script></body></html>`;

async function run(html) {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const ctx = await browser.newContext(), pg = await ctx.newPage(), logs = [];
  await ctx.route("https://www.facebook.com/**", r => r.fulfill({ contentType: "text/html", body: r.request().url().includes("/edit/") ? html : "<html><body>Your listings</body></html>" }));
  await pg.goto("https://www.facebook.com/marketplace/edit/?listing_id=42");
  const poster = new Poster({ profilesDir: os.tmpdir(), accountId: "test", log: m => logs.push(m) });
  const res = await poster.submitForm(pg, { groups: [] }, { autoPublish: true, buttonWaitMs: 25000 });
  const url = pg.isClosed() ? "" : pg.url(); await browser.close();
  return { res, logs, url };
}
test("edit page: waits for Next to enable, clicks Next, then Update", { skip: !CHROME, timeout: 90000 }, async () => {
  const { res, logs, url } = await run(page("Trailer", "Update", true));
  assert.deepEqual(res, { groups_shared: [] }, logs.join("\n"));
  assert.ok(logs.some(l => /Next is disabled - waiting/.test(l)), logs.join("\n"));
  assert.ok(logs.includes("✓ clicked Next") && logs.includes("✓ clicked Update"), logs.join("\n"));
  assert.match(url, /you\/selling/);
});
test("edit page without Next: clicks Save directly", { skip: !CHROME, timeout: 90000 }, async () => {
  const { res, logs } = await run(page("Trailer", "Save", false));
  assert.deepEqual(res, { groups_shared: [] }, logs.join("\n")); assert.ok(logs.includes("✓ clicked Save"));
});
test("edit page with Car/Truck type: not published", { skip: !CHROME, timeout: 90000 }, async () => {
  const { res, logs } = await run(page("Car/Truck", "Update", true));
  assert.equal(res.outcome, "FAILED"); assert.ok(!logs.some(l => /clicked (Next|Update)/.test(l)), logs.join("\n"));
});
