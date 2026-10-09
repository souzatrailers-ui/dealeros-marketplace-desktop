// Per-account scheduler: plans today's random post times inside business hours, capped per day,
// and runs one action at a time. Delist-on-sold runs first and is not limited by the cap.
const { randomSlots } = require("./rules");

class Scheduler {
  constructor({ account, api, poster, settings, onEvent }) {
    Object.assign(this, { account, api, poster, s: settings, emit: onEvent || (() => {}) });
    this.timer = null; this.slots = []; this.postedToday = 0; this.day = null; this.busy = false; this.paused = null;
  }
  plan(now = new Date()) {
    if (this.day !== now.toDateString()) { this.day = now.toDateString(); this.postedToday = 0; }
    const left = Math.max(0, this.s.dailyCap - this.postedToday);
    this.slots = randomSlots(left, { startHour: this.s.startHour, endHour: this.s.endHour, minGapMin: this.s.minGapMin }, now);
    this.emit("plan", this.slots.map(d => d.toLocaleTimeString()));
  }
  start() {
    if (this.timer) return;
    this.plan();
    this.timer = setInterval(() => this.tick().catch(e => this.emit("error", e.message)), 30000);
    // Near-real-time take-down: every few minutes, any hour, ask DealerOS only for SOLD_REMOVE work.
    this.delistTimer = setInterval(() => this.delistPoll().catch(e => this.emit("error", e.message)), (this.s.delistPollMin || 3) * 60000);
  }
  stop() { clearInterval(this.timer); clearInterval(this.delistTimer); this.timer = this.delistTimer = null; }
  async delistPoll() {
    if (this.busy || this.paused || !this.s.removeSold) return;
    this.busy = true;
    try {
      for (let i = 0; i < 10; i++) {          // drain all pending take-downs
        const r = await this.api.claim({ delistOnly: true });
        if (r.action !== "DELIST") break;
        const res = await this.poster.listingAction(r.job, "DELIST", this.mergedSettings(r));
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
      removeSold: srv.remove_sold ?? this.s.removeSold };
  }
  async tick(now = new Date()) {
    if (this.api.state && !this.s.mock) this.serverSettings = (await this.api.state().catch(() => ({}))).account?.settings;
    if (this.busy || this.paused || !this.mergedSettings().autoPost) return;
    if (this.day !== now.toDateString()) this.plan(now);
    if (!this.slots.length || this.slots[0] > now) return;
    this.slots.shift();
    await this.runOnce();
  }
  async runOnce() {
    this.busy = true;
    try {
      const r = await this.api.claim();
      this.emit("claim", r.action, r.reason);
      if (r.action === "POST") {
        const res = await this.poster.post(r.job, this.mergedSettings());
        if (res.outcome === "AWAITING_HUMAN") { this.emit("awaiting", r.job); return; }   // UI finishes it
        await this.api.report(r.job.id, strip(res));
        if (res.outcome === "POSTED") this.postedToday++;
        if (res.outcome === "CHECKPOINT") { this.paused = res.error; this.emit("paused", res.error); }
      } else if (["DELIST", "RENEW", "REPOST"].includes(r.action)) {
        const res = await this.poster.listingAction(r.job, r.action, this.mergedSettings());
        if (res.outcome === "AWAITING_HUMAN") { this.emit("awaiting", r.job, r.action); return; }
        await this.api.report(r.job.id, strip(res));
        if (res.outcome === "CHECKPOINT") { this.paused = res.error; this.emit("paused", res.error); }
      }
    } finally { this.busy = false; this.emit("changed"); }
  }
}
const strip = ({ page, ...rest }) => rest;
module.exports = { Scheduler };
