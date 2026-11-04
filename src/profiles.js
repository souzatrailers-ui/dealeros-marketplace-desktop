// 1.0.9: several real sales reps can share one computer. Each rep is a local profile with its own
// DealerOS session, settings, logs and its OWN Chrome user-data dir (their own Facebook login).
// Layout under userData:  profiles.json, reps/<id>/{settings.json, session.bin, logs/, chrome/}
const fs = require("fs"), path = require("path");

class ProfileStore {
  constructor(root) { this.root = root; this.file = path.join(root, "profiles.json"); this.data = null; }
  load() {
    try { this.data = JSON.parse(fs.readFileSync(this.file, "utf8")); } catch { this.data = null; }
    if (!this.data || !Array.isArray(this.data.profiles) || !this.data.profiles.length) this.migrate();
    return this;
  }
  /** Move the pre-1.0.9 single setup into "Profile 1" without losing the login: settings.json and the
   *  encrypted session.bin are moved (same OS key, so the DealerOS login survives); the existing Chrome
   *  profile folder is left where it is and referenced, so the Facebook session is untouched. */
  migrate() {
    const id = "p1", dir = path.join(this.root, "reps", id);
    fs.mkdirSync(dir, { recursive: true });
    for (const f of ["settings.json", "session.bin"]) {
      const src = path.join(this.root, f), dst = path.join(dir, f);
      if (fs.existsSync(src) && !fs.existsSync(dst)) fs.renameSync(src, dst);
    }
    const legacyChrome = fs.existsSync(path.join(this.root, "profiles"));
    this.data = { profiles: [{ id, name: "Profile 1", chromeDir: legacyChrome ? "profiles" : `reps/${id}/chrome` }], active: id, next: 2 };
    this.save();
  }
  save() { fs.mkdirSync(this.root, { recursive: true }); fs.writeFileSync(this.file, JSON.stringify(this.data, null, 1)); }
  list() { return this.data.profiles.map(p => ({ ...p })); }
  get(id) { return this.data.profiles.find(p => p.id === id) || null; }
  get active() { return this.get(this.data.active) ? this.data.active : this.data.profiles[0].id; }
  setActive(id) { if (!this.get(id)) throw new Error("No such profile"); this.data.active = id; this.save(); return id; }
  dir(id) { return path.join(this.root, "reps", id); }
  chromeDir(id) { const p = this.get(id); return path.join(this.root, p?.chromeDir || `reps/${id}/chrome`); }
  logsDir(id) { return path.join(this.dir(id), "logs"); }
  add(name) {
    const id = "p" + (this.data.next || this.data.profiles.length + 1);
    this.data.next = Number(id.slice(1)) + 1;
    const clean = String(name || "").trim().slice(0, 60) || `Profile ${id.slice(1)}`;
    this.data.profiles.push({ id, name: clean, chromeDir: `reps/${id}/chrome` });
    fs.mkdirSync(this.dir(id), { recursive: true }); this.save(); return id;
  }
  rename(id, name) { const p = this.get(id); if (!p) throw new Error("No such profile"); p.name = String(name || "").trim().slice(0, 60) || p.name; this.save(); }
  /** Removes the profile and its local data (session, settings, logs, its Chrome/Facebook folder). */
  remove(id) {
    if (this.data.profiles.length <= 1) throw new Error("Can't remove the last profile");
    const chrome = this.chromeDir(id), dir = this.dir(id);
    this.data.profiles = this.data.profiles.filter(p => p.id !== id);
    if (this.data.active === id) this.data.active = this.data.profiles[0].id;
    this.save();
    for (const d of [chrome, dir]) if (d.startsWith(this.root + path.sep)) fs.rmSync(d, { recursive: true, force: true });
  }
}

/** Only one profile drives a browser at a time. Switching to a DIFFERENT rep waits switchGapMs after the
 *  previous one finished; when other reps are waiting, the rep that just ran yields so all get turns. */
class PostingGate {
  constructor({ switchGapMs = 6 * 60000, now = () => Date.now(), waitTtlMs = 3 * 60000 } = {}) {
    Object.assign(this, { switchGapMs, now, waitTtlMs }); this.holder = null; this.lastId = null; this.lastEnd = 0; this.waiting = new Map();
    this.background = false; this.activity = null;
  }
  /** Is the browser reserved for someone other than `id`? (a rep waiting for a turn, or the switch gap after another rep) */
  reservedFor(id) {
    if (this.othersWaiting(id)) return true;
    return !!(this.lastId && this.lastId !== id && this.now() - this.lastEnd < this.switchGapMs);
  }
  /** 1.0.19: background work (sold take-down checks). Runs only when the browser is idle and not reserved,
   *  never registers as waiting, and on release does NOT restart the rep-switch wait, so it cannot steal
   *  or delay a posting turn. */
  tryAcquireBackground(id) {
    if (this.holder || this.reservedFor(id)) return false;
    this.holder = id; this.background = true; this.activity = null; return true;
  }
  /** What the holder is doing, for the UI: {kind: "post"|"take-down"|"renew"|"repost"|"leads", jobId, title}. */
  setActivity(id, activity) { if (this.holder === id) this.activity = activity || null; }
  othersWaiting(id) { const t = this.now(); for (const [k, since] of this.waiting) { if (t - since > this.waitTtlMs) this.waiting.delete(k); else if (k !== id) return true; } return false; }
  tryAcquire(id) {
    if (this.holder) { this.waiting.set(id, this.now()); return false; }
    if (this.lastId && this.lastId !== id && this.now() - this.lastEnd < this.switchGapMs) { this.waiting.set(id, this.now()); return false; }
    if (this.lastId === id && this.othersWaiting(id)) return false;          // let the next rep have a turn
    this.waiting.delete(id); this.holder = id; this.background = false; this.activity = null; return true;
  }
  release(id) {
    if (this.holder !== id) return;
    const bg = this.background;
    this.holder = null; this.background = false; this.activity = null;
    if (!bg) { this.lastId = id; this.lastEnd = this.now(); }   // background runs keep the posting rotation as it was
  }
  forget(id) { this.waiting.delete(id); if (this.holder === id) this.release(id); }
  status() {
    return { holder: this.holder, background: this.holder ? this.background : false, activity: this.holder ? this.activity : null,
      waiting: [...this.waiting.keys()], lastId: this.lastId, nextSwitchAt: this.lastId ? this.lastEnd + this.switchGapMs : 0 };
  }
}
module.exports = { ProfileStore, PostingGate };
