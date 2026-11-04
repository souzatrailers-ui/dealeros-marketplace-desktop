// Background take-down checks must never steal or delay a posting turn on a computer shared by several reps,
// must respect the server's take-down backoff, and must report failures (with app/profile info) instead of looping.
const test = require("node:test"), assert = require("node:assert");
const { Scheduler } = require("../src/scheduler");
const { PostingGate } = require("../src/profiles");
const { DealerOSApi } = require("../src/api");

function clockGate() { const c = { t: 1_000_000 }; return { c, gate: new PostingGate({ now: () => c.t }) }; }
const fakePoster = (outcome = { outcome: "FAILED", error: "Listing not found" }) =>
  ({ calls: 0, async listingAction() { this.calls++; return typeof outcome === "function" ? outcome() : outcome; }, closeStray: async () => {}, close: async () => {} });

test("background run does not reset the rep-switch wait", () => {
  const { c, gate } = clockGate();
  assert.ok(gate.tryAcquire("malina")); gate.release("malina");
  c.t += 7 * 60000;                                         // switch gap over: next rep may post
  assert.ok(gate.tryAcquireBackground("malina"));           // same rep's take-down check
  gate.release("malina");
  assert.ok(gate.tryAcquire("rep2"), "rep2 is not made to wait another 6 minutes");
});

test("background take-down is refused while another rep waits or the switch gap is reserved", () => {
  const { c, gate } = clockGate();
  assert.ok(gate.tryAcquire("malina")); gate.release("malina");
  assert.equal(gate.tryAcquireBackground("rep2"), false, "gap after malina is reserved");
  c.t += 7 * 60000;
  assert.equal(gate.tryAcquire("malina"), true); gate.release("malina");
  c.t += 7 * 60000;
  // rep2 clicks "Run next now" while malina holds the browser -> rep2 is waiting
  assert.ok(gate.tryAcquire("malina"));
  assert.equal(gate.tryAcquire("rep2"), false);
  gate.release("malina");
  assert.equal(gate.tryAcquireBackground("malina"), false, "malina's take-down check yields to waiting rep2");
  assert.equal(gate.tryAcquireBackground("rep3"), false);
  c.t += 7 * 60000;
  assert.ok(gate.tryAcquire("rep2"), "rep2 gets the posting turn");
});

test("background attempt never registers as waiting", () => {
  const { gate } = clockGate();
  assert.ok(gate.tryAcquire("rep2"));
  assert.equal(gate.tryAcquireBackground("malina"), false);
  assert.deepEqual(gate.status().waiting, []);
});

test("gate status shows which rep and job hold the browser", () => {
  const { gate } = clockGate();
  assert.ok(gate.tryAcquireBackground("rep3"));
  gate.setActivity("rep3", { kind: "take-down", jobId: 10, title: "2026 Lark 7x16" });
  const st = gate.status();
  assert.equal(st.holder, "rep3"); assert.equal(st.background, true);
  assert.deepEqual(st.activity, { kind: "take-down", jobId: 10, title: "2026 Lark 7x16" });
  gate.release("rep3");
  assert.equal(gate.status().activity, null); assert.equal(gate.status().lastId, null);
});

test("failed take-down is reported once, then the server backoff is respected", async () => {
  const { gate } = clockGate();
  const reports = []; let claims = 0;
  const api = { claim: async () => { claims++; return { action: "DELIST", job: { id: 10 } }; },
    report: async (id, r) => { reports.push([id, r]); return { id, status: "SOLD_REMOVE", retry_in_seconds: 900 }; } };
  const p = fakePoster();
  const s = new Scheduler({ account: { id: "rep3" }, api, poster: p, settings: { removeSold: true }, gate });
  await s.delistPoll();
  assert.equal(p.calls, 1, "one failure does not loop through the job again in the same pass");
  assert.equal(reports.length, 1); assert.equal(reports[0][1].outcome, "FAILED");
  await s.delistPoll(); await s.delistPoll();
  assert.equal(claims, 1, "no claim while the server backoff runs");
  s.delistRetryAt = Date.now() - 1;
  await s.delistPoll();
  assert.equal(claims, 2);
});

test("IDLE with retry_in_seconds pauses take-down polling", async () => {
  const { gate } = clockGate(); let claims = 0;
  const api = { claim: async () => { claims++; return { action: "IDLE", retry_in_seconds: 600 }; } };
  const s = new Scheduler({ account: { id: "a" }, api, poster: fakePoster(), settings: { removeSold: true }, gate });
  await s.delistPoll(); await s.delistPoll();
  assert.equal(claims, 1);
});

test("a crash during take-down is reported as FAILED instead of silently retried", async () => {
  const { gate } = clockGate(); const reports = [];
  const api = { claim: async () => ({ action: "DELIST", job: { id: 10 } }), report: async (id, r) => { reports.push(r); return {}; } };
  const p = fakePoster(() => { throw new Error("Target page closed"); });
  const s = new Scheduler({ account: { id: "a" }, api, poster: p, settings: { removeSold: true }, gate, onEvent: () => {} });
  await s.delistPoll();
  assert.equal(reports.length, 1); assert.equal(reports[0].outcome, "FAILED"); assert.match(reports[0].error, /Target page closed/);
  assert.equal(gate.holder, null);
});

test("a waiting rep stops the take-down drain between jobs", async () => {
  const { c, gate } = clockGate(); let claims = 0;
  const api = { claim: async () => { claims++; if (claims === 1) { assert.equal(gate.tryAcquire("rep2"), false); } return { action: "DELIST", job: { id: claims } }; },
    report: async () => ({}) };
  const s = new Scheduler({ account: { id: "a" }, api, poster: fakePoster({ outcome: "DELISTED" }), settings: { removeSold: true }, gate });
  await s.delistPoll();
  assert.equal(claims, 1, "drain stops as soon as rep2 is waiting");
  c.t += 1;
  assert.ok(gate.tryAcquire("rep2"), "switch wait was not restarted by the background run");
});

test("results carry app version, platform and profile", async () => {
  const sent = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => { sent.push([url, JSON.parse(opts.body || "{}")]); return { ok: true, status: 200, json: async () => ({}) }; };
  try {
    const api = new DealerOSApi({ apiBase: "https://x.test", session: { access_token: "t" },
      clientInfo: () => ({ app_version: "9.9.9", platform: "win32", profile: "Rep B" }) });
    await api.report(10, { outcome: "FAILED", error: "nope" });
    await api.report(10, { outcome: "DELISTED" });
  } finally { global.fetch = realFetch; }
  assert.match(sent[0][0], /\/jobs\/10\/result$/);
  assert.deepEqual(sent[0][1], { app_version: "9.9.9", platform: "win32", profile: "Rep B", outcome: "FAILED", error: "nope" });
  assert.match(sent[1][0], /\/jobs\/10\/delisted$/);
  assert.equal(sent[1][1].profile, "Rep B");
});
