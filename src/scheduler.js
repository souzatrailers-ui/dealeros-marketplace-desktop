// Per-profile (per-rep) scheduler: plans today's random post times inside business hours, capped per day,
// and runs one action at a time. Delist-on-sold runs first and is not limited by the cap.
const { randomSlots } = require("./rules");

class Scheduler {
  constructor({ account, api, poster, settings, onEvent, gate }) {
    Object.assign(this, { account, api, poster, s: settings, emit: onEvent || (() => {}), gate: gate || null });
    this.timer = null; this.slots = []; this.postedToday = 0; this.day = null; this.busy = false; this.paused = null;
  }
  plan(now = new Date()) {
    if (this.day !== now.toDateString()) { this.day = now.toDateString(); this.postedToday = 0; }
    const left = Math.max(0, this.cap() - this.postedToday);
    this.slots = randomSlots(left, { startHour: this.s.startHour, endHour: this.s.endHour, minGapMin: this.serverSettings?.min_gap_min ?? this.s.minGapMin }, now);
    this.emit("plan", this.slots.map(d => d.toLocaleTimeString()));
  }
  /** Daily cap: the rep's DealerOS account value wins (server also enforces it at claim). */
  cap() { return Number(this.serverCap ?? this.s.dailyCap) || 0; }
  /** 1.0.9: one profile at a time across the computer. Returns false if another rep holds the browser. */
  async gated(fn) {
    if (this.running) return false;                 // never start a poll/post while the previous one is still running
    if (this.gate && !this.gate.tryAcquire(this.account.id)) return false;
    this.running = true;
    try { await fn(); return true; }
    finally {
      try { await this.poster?.enforcePageCap?.().catch?.(() => {}); } catch {}
      // Reuse this rep's Chrome window across passes. Closing it here made the next
      // selling-page check (every few minutes) launch a new window, and on Mac the old
      // one stayed open. Close only when a different rep is waiting for the computer.
      const handoff = !!(this.gate && this.gate.othersWaiting(this.account.id));
      if (handoff) { try { await this.poster?.close?.().catch?.(() => {}); } catch {} }
      if (this.gate) this.gate.release(this.account.id);
      this.running = false;
    }
  }
  start() {
    if (this.timer) return;
    this.plan();
    this.timer = setInterval(() => this.tick().catch(e => this.fail(e)), 30000);
    // Near-real-time take-down: every few minutes, any hour, ask DealerOS only for SOLD_REMOVE work.
    this.delistTimer = setInterval(() => this.delistPoll().catch(e => this.fail(e)), (this.s.delistPollMin || 3) * 60000);
  }
  stop() { clearInterval(this.timer); clearInterval(this.delistTimer); this.timer = this.delistTimer = null; }
  async delistPoll() {
    if (this.busy || this.running || this.paused || !this.s.removeSold) return;
    return this.gated(() => this.drainDelists());
  }
  async drainDelists() {
    this.busy = true;
    try {
      for (let i = 0; i < 10; i++) {          // drain all pending take-downs
        const r = await this.api.claim({ delistOnly: true });
        if (r.action !== "DELIST") break;
        let res;
        try { res = await this.poster.listingAction(r.job, "DELIST", this.mergedSettings(r)); }
        catch (e) { await this.poster.closeStray?.(); throw e; }
        if (res.outcome === "AWAITING_HUMAN") { this.emit("awaiting", r.job, "DELIST"); break; }
        await this.api.report(r.job.id, strip(res));
        if (res.outcome === "CHECKPOINT") { this.paused = res.error; this.emit("paused", res.error); break; }
      }
    } finally { this.busy = false; this.emit("changed"); }
  }
  // Live mode: the DealerOS account settings (manager-controlled) override local toggles.
  mergedSettings() {
    const srv = this.serverSettings || {};
    return { ...this.s, autoPublish: srv.auto_publish ?? this.s.autoPublish, autoPost: srv.auto_post ?? this.s.autoPost,
      removeSold: srv.remove_sold ?? this.s.removeSold, hideVehicleDetails: srv.hide_vehicle_details ?? this.s.hideVehicleDetails };
  }
  fail(e) {
    if (e && (e.signOut || e.status === 401)) { this.emit("auth-expired"); return; }
    this.emit("error", String(e && e.message || e || ""));
  }
  async tick(now = new Date()) {
    if (this.api.state && !this.s.mock) {
      try {
        const acct = (await this.api.state()).account || {};
        this.serverSettings = acct.settings; if (acct.daily_cap != null && acct.daily_cap !== this.serverCap) { this.serverCap = acct.daily_cap; this.plan(now); }
      } catch (e) { this.fail(e); if (e && (e.signOut || e.status === 401)) return; }
    }
    if (this.busy || this.running || this.paused || !this.mergedSettings().autoPost) return;
    if (this.day !== now.toDateString()) this.plan(now);
    if (!this.slots.length || this.slots[0] > now) return;
    if (this.postedToday >= this.cap()) { this.slots = []; return; }
    await this.gated(async () => { this.slots.shift(); await this.runOnce(); });   // slot kept if another rep is posting
  }
  async runOnce() {
    this.busy = true;
    try {
      const r = await this.api.claim();
      this.lastClaim = r;
      this.emit("claim", r.action, r.reason);
      if (r.action === "POST") {
        let res;
        try { res = await this.poster.post(r.job, this.mergedSettings()); }
        catch (e) { res = { outcome: "FAILED", error: "Posting crashed: " + String(e.message || e).split("\n")[0].slice(0, 300) }; await this.poster.closeStray?.(); }
        if (res.outcome === "AWAITING_HUMAN") { this.emit("awaiting", r.job, null, res.reason || "", res.warnings || []); return; }   // UI finishes it
        await this.api.report(r.job.id, strip(res));
        this.emit("result", { id: r.job.id, title: r.job.payload?.title, outcome: res.outcome, url: res.marketplace_url || "", error: res.error || "" });
        if (res.outcome === "POSTED") this.postedToday++;
        if (res.outcome === "CHECKPOINT") { this.paused = res.error; this.emit("paused", res.error); }
      } else if (["DELIST", "RENEW", "REPOST"].includes(r.action)) {
        let res;
        try { res = await this.poster.listingAction(r.job, r.action, this.mergedSettings()); }
        catch (e) { this.emit("error", `${r.action} failed: ${String(e.message || e).split("\n")[0]}`); await this.poster.closeStray?.(); return; }
        if (res.outcome === "AWAITING_HUMAN") { this.emit("awaiting", r.job, r.action); return; }
        await this.api.report(r.job.id, strip(res));
        if (res.outcome === "CHECKPOINT") { this.paused = res.error; this.emit("paused", res.error); }
      }
    } catch (e) { this.fail(e); }
    finally { this.busy = false; this.emit("changed"); }
  }
}
const strip = ({ page, ...rest }) => rest;
module.exports = { Scheduler };
