const test = require("node:test"), assert = require("node:assert");
const { DealerOSApi, sessionWithProfile, SIGN_IN } = require("../src/api");
const { Scheduler } = require("../src/scheduler");

function json(status, body) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

test("merging a profile keeps the tokens from after the refresh", () => {
  // `{ ...session, ...(await api.me()) }` copies `session` before the await.
  // /auth/me refreshes and saves the new pair, then the assignment writes the
  // pre-await copy back. The name and dealership survive, so Account still
  // looks signed in while the queue holds the revoked refresh token.
  let session = {
    access_token: "OLD", refresh_token: "R0",
    user: { id: 7, full_name: "SAMUEL B DE SOUZA", email: "souzatrailers@gmail.com" },
    organization_id: 1, facebook_accounts: [{ label: "Sam" }]
  };
  const snapshot = { ...session };
  session = sessionWithProfile(
    { access_token: "NEW", refresh_token: "R1", expires_in: 43200, token_type: "Bearer", scope: "marketplace" },
    session);
  const profile = { user: session.user, organization_id: 1, facebook_accounts: session.facebook_accounts };
  const clobbered = { ...snapshot, ...profile };
  assert.equal(clobbered.access_token, "OLD");
  assert.equal(clobbered.user.email, "souzatrailers@gmail.com");
  const kept = sessionWithProfile(session, profile);
  assert.equal(kept.access_token, "NEW");
  assert.equal(kept.refresh_token, "R1");
  assert.equal(kept.user.full_name, "SAMUEL B DE SOUZA");
  assert.equal(kept.organization_id, 1);
  assert.equal(kept.facebook_accounts[0].label, "Sam");
});

test("parallel 401s share one refresh and the saved pair is the new one", async (t) => {
  const saved = [];
  let refreshCalls = 0;
  const original = global.fetch;
  t.after(() => { global.fetch = original; });
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.endsWith("/auth/refresh")) {
      refreshCalls++;
      await new Promise(resolve => setTimeout(resolve, 20));
      return json(200, { access_token: "A1", refresh_token: "R1", expires_in: 43200, token_type: "Bearer", scope: "marketplace" });
    }
    const auth = (opts.headers || {}).Authorization || "";
    if (!String(auth).includes("A1")) return json(401, { detail: "Invalid, expired or revoked token - sign in again" });
    if (u.endsWith("/jobs")) return json(200, { counters: { queue: 1 }, jobs: [{ id: 1 }] });
    if (u.endsWith("/auth/me")) return json(200, {
      user: { id: 7, full_name: "SAMUEL B DE SOUZA", email: "souzatrailers@gmail.com" },
      organization_id: 1, facebook_accounts: [{ label: "Sam" }]
    });
    return json(404, {});
  };
  const api = new DealerOSApi({
    apiBase: "https://app.dealerosai.ai",
    session: {
      access_token: "OLD", refresh_token: "R0",
      user: { id: 7, full_name: "SAMUEL B DE SOUZA", email: "souzatrailers@gmail.com" },
      organization_id: 1, facebook_accounts: [{ label: "Sam" }]
    },
    onTokens: s => saved.push({ access: s.access_token, refresh: s.refresh_token, email: s.user && s.user.email })
  });
  const [jobs, me] = await Promise.all([api.req("/jobs"), api.req("/auth/me")]);
  assert.equal(refreshCalls, 1);
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0], { access: "A1", refresh: "R1", email: "souzatrailers@gmail.com" });
  assert.equal(api.session.access_token, "A1");
  assert.equal(api.session.refresh_token, "R1");
  assert.equal(jobs.jobs[0].id, 1);
  assert.equal(me.organization_id, 1);
  const shown = sessionWithProfile(api.session, me);
  assert.equal(shown.access_token, "A1");
  assert.equal(shown.user.email, "souzatrailers@gmail.com");
});

test("a rejected refresh tells the app to sign out", async (t) => {
  const original = global.fetch;
  t.after(() => { global.fetch = original; });
  global.fetch = async () => json(401, { detail: "Refresh token invalid or expired - sign in again" });
  const api = new DealerOSApi({
    apiBase: "https://app.dealerosai.ai",
    session: { access_token: "OLD", refresh_token: "R0" },
    onTokens: () => { throw new Error("must not save a rejected refresh"); }
  });
  await assert.rejects(() => api.refresh(), e => e.signOut === true && e.status === 401 && e.message === SIGN_IN);
  assert.equal(api.session.refresh_token, "R0");
});

test("a dropped connection does not sign the account out", async (t) => {
  const original = global.fetch;
  t.after(() => { global.fetch = original; });
  global.fetch = async () => { throw new Error("network down"); };
  const api = new DealerOSApi({
    apiBase: "https://app.dealerosai.ai",
    session: { access_token: "OLD", refresh_token: "R0" },
    onTokens: () => { throw new Error("must not save when the refresh never answered"); }
  });
  await assert.rejects(() => api.refresh(), e => e.signOut !== true && e.status === 0 && /connection/i.test(e.message));
  assert.equal(api.session.access_token, "OLD");
});

test("the scheduler stops when DealerOS rejects the sign-in", async () => {
  const events = [];
  const scheduler = new Scheduler({
    account: { id: "sam" },
    api: { state: async () => { throw Object.assign(new Error(SIGN_IN), { status: 401, signOut: true }); } },
    poster: {},
    settings: { mock: false, autoPost: true, startHour: 9, endHour: 18, minGapMin: 3, dailyCap: 5 },
    onEvent: ev => events.push(ev)
  });
  await scheduler.tick(new Date(2026, 9, 19, 10, 17));
  assert.deepEqual(events, ["auth-expired"]);
});
