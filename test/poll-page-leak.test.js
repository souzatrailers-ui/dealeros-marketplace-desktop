// Selling-page checks run every few minutes. They must reuse one Chrome window.
// 1.0.13 closed the Playwright handle after every pass, so the next pass launched another
// window; on Mac the old one stayed open (400+ Marketplace windows).
const test = require("node:test"), assert = require("node:assert");
const fs = require("fs"), os = require("os"), path = require("path");
const { Poster, MAX_PAGES, calmChromeProfile, commandUsesProfile, reapChromeProcesses } = require("../src/poster");
const { Scheduler } = require("../src/scheduler");
const { PostingGate } = require("../src/profiles");

function fakeCtx() {
  const pages = [];
  const mk = () => { const p = { closed: false, urls: [], isClosed() { return this.closed; },
    async close() { this.closed = true; pages.splice(pages.indexOf(this), 1); },
    async goto(u) { if (this.failGoto) throw new Error("net::ERR_TIMED_OUT"); this.urls.push(u); }, url() { return this.urls.at(-1) || "about:blank"; },
    getByRole() { return { count: async () => 0, first() { return this; } }; }, locator() { return { evaluateAll: async () => [], innerText: async () => "" }; },
    evaluate: async () => ({ listing_url: "", buyer_name: "", messages: [] }), waitForLoadState: async () => {} }; pages.push(p); return p; };
  return { pages: () => pages.slice(), newPage: async () => mk(), on() {}, close: async () => { pages.length = 0; }, _all: pages };
}
function poster(ctx) {
  const p = new Poster({ profilesDir: "/tmp/x", accountId: "t", fbBase: "https://www.facebook.com", log: () => {} });
  p._launch = async () => (p.ctx = ctx); p.checkpoint = async () => null; return p;
}
const S = { fbBase: "https://www.facebook.com", autoPublish: true };

test("repeated selling-page checks reuse one tab", async () => {
  const ctx = fakeCtx(), p = poster(ctx);
  for (let i = 0; i < 50; i++) assert.equal((await p.listingAction({}, "DELIST", S)).outcome, "AWAITING_HUMAN");
  assert.equal(ctx._all.length, 1);
  assert.ok(ctx._all[0].urls.includes("https://www.facebook.com/marketplace/you/selling"));
});
test("tab is cleaned up even when navigation throws, and on checkpoint / manual mode", async () => {
  const ctx = fakeCtx(), p = poster(ctx);
  const pg = await p.getPollPage(); pg.failGoto = true;
  await assert.rejects(p.listingAction({}, "DELIST", S));
  pg.failGoto = false; p.checkpoint = async () => "checkpoint";
  for (let i = 0; i < 10; i++) await p.listingAction({}, "DELIST", S);
  p.checkpoint = async () => null;
  for (let i = 0; i < 10; i++) await p.listingAction({}, "DELIST", { ...S, autoPublish: false });
  assert.equal(ctx._all.length, 1);
});
test("page cap closes extras beyond MAX_PAGES but keeps the first and the poll tab", async () => {
  const ctx = fakeCtx(), p = poster(ctx); await p.open();
  const first = await ctx.newPage(); for (let i = 0; i < 20; i++) await ctx.newPage();
  const keep = ctx._all[5];
  await p.enforcePageCap(MAX_PAGES, keep);
  assert.equal(MAX_PAGES, 3); assert.equal(ctx._all.length, 3);
  assert.ok(ctx._all.includes(first) && ctx._all.includes(keep));
});
test("concurrent open() launches the browser once", async () => {
  let launches = 0; const p = new Poster({ profilesDir: "/tmp/x", accountId: "t", log: () => {} });
  p._launch = async () => { launches++; await new Promise(r => setTimeout(r, 20)); return (p.ctx = fakeCtx()); };
  await Promise.all([p.open(), p.open(), p.open()]); assert.equal(launches, 1);
});
test("scheduler does not start a new poll while one is still running, and keeps the browser", async () => {
  let claims = 0, release; const ctx = fakeCtx(), p = poster(ctx); let closes = 0; const realClose = p.close.bind(p); p.close = async () => { closes++; return realClose(); };
  const api = { claim: async () => { claims++; await new Promise(r => (release = r)); return { action: "NONE" }; } };
  const s = new Scheduler({ account: { id: "a" }, api, poster: p, settings: { removeSold: true }, gate: new PostingGate() });
  const first = s.delistPoll(); await new Promise(r => setImmediate(r));
  assert.ok(!(await s.delistPoll())); assert.equal(await s.gated(async () => claims++), false);
  release(); await first;
  assert.equal(claims, 1); assert.equal(closes, 0); assert.equal(s.running, false);
});
test("scheduled selling checks reuse one browser across ticks and stay under the page cap", async () => {
  let launches = 0; const ctx = fakeCtx();
  const p = new Poster({ profilesDir: "/tmp/x", accountId: "t", fbBase: "https://www.facebook.com", log: () => {} });
  p._launch = async () => { launches++; return ctx; }; p.checkpoint = async () => null;
  const api = { claim: async () => ({ action: "DELIST", job: { id: "j" + launches } }), report: async () => {} };
  const s = new Scheduler({ account: { id: "a" }, api, poster: p, settings: { removeSold: true, autoPublish: true, fbBase: "https://www.facebook.com" }, gate: new PostingGate() });
  for (let i = 0; i < 40; i++) await s.delistPoll();
  assert.equal(launches, 1);
  assert.equal(ctx._all.length, 1);
  assert.ok(ctx._all.length <= MAX_PAGES);
  assert.ok(ctx._all[0].urls.includes("https://www.facebook.com/marketplace/you/selling"));
});
test("a waiting rep is the only reason a pass closes the browser", async () => {
  let release; const ctx = fakeCtx(), p = poster(ctx); let closes = 0; p.close = async () => { closes++; };
  const gate = new PostingGate();
  const api = { claim: async () => { await new Promise(r => (release = r)); return { action: "NONE" }; } };
  const s = new Scheduler({ account: { id: "a" }, api, poster: p, settings: { removeSold: true }, gate });
  const first = s.delistPoll(); await new Promise(r => setImmediate(r));
  assert.equal(gate.tryAcquire("other"), false);   // other rep is now waiting
  release(); await first;
  assert.equal(closes, 1); assert.equal(s.running, false); assert.equal(gate.holder, null);
});
test("repeated lead reads reuse one tab", async () => {
  const ctx = fakeCtx(), p = poster(ctx);
  await p.readLeadThreads({ inboxUrl: "https://www.facebook.com/marketplace/inbox/" });
  await p.readLeadThreads({ inboxUrl: "https://www.facebook.com/marketplace/inbox/" });
  assert.equal(ctx._all.length, 1);
  assert.ok(ctx._all[0].urls.includes("https://www.facebook.com/marketplace/inbox/"));
});
test("poll reuses the window Chrome already opened instead of creating another", async () => {
  const ctx = fakeCtx(); const first = await ctx.newPage(); const p = poster(ctx);
  const page = await p.getPollPage();
  assert.equal(page, first); assert.equal(ctx._all.length, 1);
  await p.getPollPage(); assert.equal(ctx._all.length, 1);
});
test("open() trims a restored pile of windows down to the cap", async () => {
  const ctx = fakeCtx(); for (let i = 0; i < 40; i++) await ctx.newPage();
  const p = poster(ctx); await p.open();
  assert.equal(ctx._all.length, MAX_PAGES);
});
test("close during launch disposes that window instead of keeping it", async () => {
  const p = new Poster({ profilesDir: "/tmp/x", accountId: "t", log: () => {} });
  let ctx, release;
  p._launch = () => new Promise(r => { release = () => { ctx = fakeCtx(); r(ctx); }; });
  const opening = p.open();
  await new Promise(r => setImmediate(r));
  const closing = p.close();
  release();
  await assert.rejects(opening, /cancelled/);
  await closing;
  assert.equal(p.ctx, null);
  assert.equal(ctx._all.length, 0);
});
test("if Chrome refuses to close, the next run reuses it instead of launching another", async () => {
  const ctx = fakeCtx(); ctx.close = async () => { throw new Error("mac chrome ignored close"); };
  const p = new Poster({ profilesDir: "/tmp/x", accountId: "t", log: () => {} });
  let launches = 0; p._launch = async () => { launches++; return ctx; };
  await p.open();
  await p.close();
  await p.open();
  assert.equal(launches, 1);
  assert.equal(p.ctx, ctx);
});
test("calmChromeProfile drops restored windows and marks a clean exit", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chrome-profile-"));
  const def = path.join(dir, "Default");
  fs.mkdirSync(path.join(def, "Sessions"), { recursive: true });
  fs.writeFileSync(path.join(def, "Current Session"), "windows");
  fs.writeFileSync(path.join(def, "Last Tabs"), "tabs");
  fs.writeFileSync(path.join(def, "Sessions", "Session_1"), "x");
  fs.writeFileSync(path.join(def, "Preferences"), JSON.stringify({ profile: { exit_type: "Crashed", exited_cleanly: false }, session: { restore_on_startup: 1, startup_urls: ["https://www.facebook.com/marketplace/you/selling"] }, something: 1 }));
  calmChromeProfile(dir);
  assert.equal(fs.existsSync(path.join(def, "Current Session")), false);
  assert.equal(fs.existsSync(path.join(def, "Last Tabs")), false);
  assert.equal(fs.existsSync(path.join(def, "Sessions")), false);
  const prefs = JSON.parse(fs.readFileSync(path.join(def, "Preferences"), "utf8"));
  assert.equal(prefs.profile.exit_type, "Normal");
  assert.equal(prefs.profile.exited_cleanly, true);
  assert.equal(prefs.session.restore_on_startup, 5);
  assert.equal(prefs.session.startup_urls, undefined);
  assert.equal(prefs.something, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});
test("reap only kills Chrome on this rep's profile, not the user's normal Chrome", () => {
  const dir = "/Users/me/Library/Application Support/DealerOS Marketplace/reps/p1/chrome/account-u1-o2";
  const own = `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=${dir} --no-first-run`;
  const normal = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/Users/me/Library/Application Support/Google/Chrome --no-first-run";
  assert.equal(commandUsesProfile(own, dir), true);
  assert.equal(commandUsesProfile(normal, dir), false);
  assert.equal(commandUsesProfile("chrome --user-data-dir=/tmp/x/account-t-extra --foo", "/tmp/x/account-t"), false);
  assert.equal(commandUsesProfile("chrome --user-data-dir /tmp/x/account-t", "/tmp/x/account-t"), true);
  const killed = [];
  const n = reapChromeProcesses("/tmp/x/account-t", {
    list: () => [`11 chrome --user-data-dir=/tmp/x/account-t --start-maximized`, `12 ${normal}`, `${process.pid} chrome --user-data-dir=/tmp/x/account-t`].join("\n"),
    kill: pid => killed.push(pid)
  });
  assert.deepEqual(n, [11]);
  assert.deepEqual(killed, [11]);
  assert.deepEqual(reapChromeProcesses("/tmp", { list: () => "1 chrome --user-data-dir=/tmp", kill: () => { throw new Error("must not kill"); } }), []);
});
