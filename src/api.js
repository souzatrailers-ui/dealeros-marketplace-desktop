// Job source: DealerOS extension API (Bearer token) or mock mode (public inventory, local state file).
const fs = require("fs");
const path = require("path");
const { cleanDescription, renewalDue, RULES } = require("./rules");
const { applyVariant } = require("./variants");

class DealerOSApi {
  /** session: {access_token, refresh_token}; onTokens(newPair) persists rotated tokens (encrypted). */
  constructor({ apiBase, session, onTokens = () => {} }) {
    this.base = apiBase.replace(/\/$/, "") + "/api/public/marketplace-ext"; this.session = session || {}; this.onTokens = onTokens;
  }
  static async login(apiBase, { username, password, mfa_code, organization_id, device_name }) {
    const r = await fetch(apiBase.replace(/\/$/, "") + "/api/public/marketplace-ext/auth/login", { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password, mfa_code, organization_id, device_name }) });
    const b = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(b.detail || "HTTP " + r.status); e.status = r.status; throw e; }
    return b;
  }
  async refresh() {
    const r = await fetch(this.base + "/auth/refresh", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: this.session.refresh_token }) });
    if (!r.ok) throw Object.assign(new Error("Session expired - sign in again"), { status: 401, signOut: true });
    const pair = await r.json(); this.session = { ...this.session, ...pair }; this.onTokens(this.session); return pair;
  }
  async req(p, opts = {}, retry = true) {
    const r = await fetch(this.base + p, { ...opts, headers: { Authorization: "Bearer " + this.session.access_token, "Content-Type": "application/json" } });
    if (r.status === 401 && retry && this.session.refresh_token) { await this.refresh(); return this.req(p, opts, false); }
    const b = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(b.detail || "HTTP " + r.status), { status: r.status });
    return b;
  }
  me() { return this.req("/auth/me"); }
  logout() { return this.req("/auth/logout", { method: "POST" }, false).catch(() => null); }
  fbConnect(info) { return this.req("/facebook/connect", { method: "POST", body: JSON.stringify(info) }); }
  fbDisconnect() { return this.req("/facebook/disconnect", { method: "POST" }); }
  postLeads(threads) { return this.req("/leads", { method: "POST", body: JSON.stringify({ threads }) }); }
  state() { return this.req("/jobs"); }
  claim(o = {}) { return this.req("/jobs/claim", { method: "POST", body: JSON.stringify({ delist_only: !!o.delistOnly }) }); }
  report(id, result) {
    const map = { DELISTED: "delisted", RENEWED: "renewed", REPOSTED: "reposted" };
    if (map[result.outcome]) return this.req(`/jobs/${id}/${map[result.outcome]}`, { method: "POST" });
    return this.req(`/jobs/${id}/result`, { method: "POST", body: JSON.stringify(result) });
  }
}

class MockApi {
  constructor({ dataDir, settings, accountId = "mock", accountIds = null, rep = {} }) {
    this.file = path.join(dataDir, `mock-jobs-${accountId}.json`); this.s = settings;
    Object.assign(this, { accountId, accountIds: accountIds || [accountId], rep });
  }
  load() { try { return JSON.parse(fs.readFileSync(this.file, "utf8")); } catch { return null; } }
  save(j) { fs.writeFileSync(this.file, JSON.stringify(j, null, 1)); }
  async jobs() {
    const s = this.s, units = await (await fetch(s.mockInventoryUrl)).json();
    const abs = u => (u && u.startsWith("/") ? s.mockAssetBase + u : u);
    let jobs = this.load();
    const avail = new Set(units.filter(u => u.status === "AVAILABLE").map(u => u.id));
    if (jobs) {
      for (const j of jobs) if (!avail.has(j.inventory_id)) {
        if (j.status === "POSTED" && s.removeSold) j.status = "SOLD_REMOVE";
        else if (["QUEUED", "APPROVED", "FAILED"].includes(j.status)) j.status = "REMOVED";
      }
    } else {
      const footer = RULES.join("\n");
      jobs = units.filter(u => u.status === "AVAILABLE" && (u.cash_price > 0 || s.postWithoutPrice) && u.photo_url).map(u => ({
        id: "mock-" + u.id, inventory_id: u.id, status: s.autoPost ? "APPROVED" : "QUEUED",
        payload: {
          title: [u.year, u.manufacturer, u.model, u.category].filter(Boolean).join(" ").slice(0, 99),
          price: Math.round(u.cash_price || 0), vin: u.vin, year: u.year, make: u.manufacturer, model: u.model,
          vehicle_type: "Trailer", category: "Trailers", category_label: u.category, condition_raw: u.condition, condition: u.condition === "NEW" ? "New" : "Used - Good",
          description: cleanDescription(u.description), unknown_make: s.unknownMake,
          groups: s.postToGroups ? s.groups.slice(0, s.maxGroupsPerListing) : [],
          photos: [u.photo_url, ...(u.photos || []).map(p => p.url || p)].filter(Boolean).map(abs).filter((v, i, a) => a.indexOf(v) === i).slice(0, 20)
        }
      })).map(j => ({ ...j, payload: applyVariant(j.payload, j.inventory_id, this.accountId, footer, this.rep, this.accountIds,
        s.postToGroups ? s.groups : [], s.maxGroupsPerListing) }));
    }
    this.save(jobs); return jobs;
  }
  async state() {
    const jobs = await this.jobs(), n = st => jobs.filter(j => st.includes(j.status)).length;
    return { counters: { queue: n(["QUEUED", "APPROVED"]), processed: jobs.length, posted: n(["POSTED"]),
      sold: jobs.filter(j => j.status === "SOLD_REMOVE" || (j.status === "REMOVED" && j.removed_reason !== "REPOST")).length }, jobs };
  }
  async postLeads(threads) { return { results: threads.map(t => ({ thread_id: t.thread_id, mock: true, messages: (t.messages || []).length })) }; }
  async approve(id) { const jobs = await this.jobs(); const j = jobs.find(x => x.id === id); if (j) j.status = "APPROVED"; this.save(jobs); }
  async claim(o = {}) {
    const jobs = await this.jobs();
    const del = jobs.find(j => j.status === "SOLD_REMOVE"); if (del) return { action: "DELIST", job: del };
    if (o.delistOnly) return { action: "IDLE" };
    for (const j of jobs.filter(x => x.status === "POSTED")) { const due = renewalDue(j, this.s); if (due) return { action: due, job: j }; }
    const ready = jobs.filter(j => j.status === "APPROVED");
    if (!ready.length) return { action: "IDLE" };
    const j = this.s.autoPost ? ready[Math.floor(Math.random() * ready.length)] : ready[0];
    j.status = "POSTING"; this.save(jobs); return { action: "POST", job: j };
  }
  async report(id, r) {
    const jobs = await this.jobs(), j = jobs.find(x => x.id === id); if (!j) return;
    const now = new Date().toISOString();
    if (r.outcome === "POSTED") Object.assign(j, { status: "POSTED", posted_at: now, marketplace_url: r.marketplace_url || null, groups_shared: r.groups_shared || [] });
    else if (r.outcome === "RENEWED") Object.assign(j, { renewed_at: now, renew_count: (j.renew_count || 0) + 1 });
    else if (r.outcome === "REPOSTED") { Object.assign(j, { status: "REMOVED", removed_reason: "REPOST" }); jobs.push({ ...j, id: j.id + "-r" + Date.now(), status: "APPROVED", removed_reason: null, posted_at: null, renew_count: 0, marketplace_url: null }); }
    else if (r.outcome === "DELISTED") j.status = "REMOVED";
    else if (r.outcome === "CANCELLED") j.status = "APPROVED";
    else Object.assign(j, { status: "FAILED", error: r.error || r.outcome });
    this.save(jobs); return j;
  }
}
module.exports = { DealerOSApi, MockApi };
