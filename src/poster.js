// Playwright posting module. Each Facebook account gets its own persistent profile
// (userDataDir). The salesperson logs in once inside that window; DealerOS never sees
// cookies or passwords. The browser is visible (headful): the human watches each post.
const path = require("path");
const FC = require("./formcheck");
const { exteriorColor } = require("./colors");
const FC_SRC = require("fs").readFileSync(require("path").join(__dirname, "formcheck.js"), "utf8").replace("typeof module !== \"undefined\" && module.exports", "false");
const fs = require("fs");
const { chromium } = require("playwright-core");
const { parseInbox } = require("./inbox-parse");

const CHECKPOINT_TEXT = ["confirm your identity", "we limited how often you can post", "you're temporarily blocked",
  "your account is restricted", "security check", "enter the code", "suspicious activity", "you can't post",
  "help us confirm it's you", "we suspended your account"];
const MAX_PAGES = 3;   // hard cap on open automation tabs/windows per rep profile
// Session restore is what turned one missed close into hundreds of Marketplace windows.
const CHROME_ARGS = ["--start-maximized", "--disable-session-crashed-bubble", "--hide-crash-restore-bubble",
  "--disable-features=InfiniteSessionRestore", "--no-first-run", "--no-default-browser-check"];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const jitter = (a, b) => sleep(a + Math.random() * (b - a));

function profileDirFor(profilesDir, accountId) { return path.join(profilesDir, "account-" + accountId); }
/** Only the app's own per-account Chrome folder. Never a normal Chrome profile. */
function isAppChromeProfile(dir) {
  return /^account-[A-Za-z0-9._-]+$/.test(path.basename(path.resolve(String(dir || ""))));
}
/** True when a process command line is Chrome launched on exactly this profile directory. */
function commandUsesProfile(command, dir) {
  if (!isAppChromeProfile(dir)) return false;
  const target = path.resolve(String(dir)).replace(/[\\/]+$/, "");
  const re = /--user-data-dir(?:=|\s+)(?:"([^"]*)"|'([^']*)'|(\S[\s\S]*?))(?=\s--|$)/g;
  let m;
  while ((m = re.exec(String(command || "")))) {
    const raw = (m[1] ?? m[2] ?? m[3] ?? "").trim();
    if (!raw) continue;
    let got; try { got = path.resolve(raw).replace(/[\\/]+$/, ""); } catch { continue; }
    if (got === target) return true;
  }
  return false;
}
function listProcessCommands(execFileSync = require("child_process").execFileSync) {
  try { return execFileSync("ps", ["-ax", "-o", "pid=", "-o", "command="], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }); }
  catch { return ""; }
}
/** Kill Chrome processes still using this rep's profile. A Playwright close often leaves the Mac window up. */
function reapChromeProcesses(dir, deps = {}) {
  if (!isAppChromeProfile(dir)) return [];
  const text = deps.list ? deps.list() : listProcessCommands();
  const kill = deps.kill || ((pid, sig) => process.kill(pid, sig));
  const killed = [];
  for (const line of String(text).split("\n")) {
    const m = line.trim().match(/^(\d+)\s+([\s\S]+)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    if (!pid || pid === process.pid) continue;
    if (!commandUsesProfile(m[2], dir)) continue;
    try { kill(pid, "SIGKILL"); killed.push(pid); } catch {}
  }
  return killed;
}
/** Forget restored windows without touching cookies, so the next launch cannot reopen the pile. */
function calmChromeProfile(dir) {
  const def = path.join(dir, "Default");
  fs.mkdirSync(def, { recursive: true });
  for (const name of ["Current Session", "Current Tabs", "Last Session", "Last Tabs"]) fs.rmSync(path.join(def, name), { force: true });
  fs.rmSync(path.join(def, "Sessions"), { recursive: true, force: true });
  const prefsPath = path.join(def, "Preferences");
  let prefs = {};
  try { prefs = JSON.parse(fs.readFileSync(prefsPath, "utf8")); } catch { prefs = {}; }
  prefs.profile = { ...(prefs.profile || {}), exit_type: "Normal", exited_cleanly: true };
  prefs.session = { ...(prefs.session || {}), restore_on_startup: 5 };   // 5 = New Tab page, not "continue where you left off"
  delete prefs.session.startup_urls;
  fs.writeFileSync(prefsPath, JSON.stringify(prefs));
}

// "COMING SOON / Representative image" covered-trailer placeholder served by the website platform (cdn-thumbor.autodealersdigital.com).
const PLACEHOLDER_SHA256 = new Set(["d78099e3f1b862f2b75c577c260bdc21159644f43f76445bf459a030fde3374b", "1b917fc8dbc7148547464c36b5834efaf6e69bb3564e10dc9010fd38c0ccd95f"]);
const PLACEHOLDER_DHASH = [0x0fccf19094e0f85dn, 0x4de8f1d1d8e07069n];   // Electron nativeImage 9x8 dHash (1000x750 + 1200x630 crops); real Souza photos are >= 20 bits away
class Poster {
  /** opts: { profilesDir, accountId, executablePath?, fbBase, log } */
  constructor(opts) { this.o = opts; this.ctx = null; this._generation = 0; }
  profileDir() { return profileDirFor(this.o.profilesDir, this.o.accountId); }
  _usable(ctx = this.ctx) {
    if (!ctx) return false;
    try {
      if (typeof ctx.pages === "function" && !Array.isArray(ctx.pages())) return false;
      const browser = typeof ctx.browser === "function" ? ctx.browser() : null;
      if (browser && typeof browser.isConnected === "function" && !browser.isConnected()) return false;
      return true;
    } catch { return false; }
  }

  async open() {
    if (this._usable()) return this.ctx;
    // Concurrent callers share ONE launch. Two launches orphaned a Chrome window that was never closed.
    if (this._opening) return this._opening;
    const generation = this._generation;
    let promise;
    promise = (async () => {
      const ctx = await this._launch();
      if (generation !== this._generation) {
        if (this.ctx === ctx) this.ctx = null;
        try { await this._abandon(ctx); }
        catch (e) { this.o.log?.("⚠ browser close: " + (e.message || e)); this.ctx = ctx; }
        throw Object.assign(new Error("browser launch cancelled"), { cancelled: true });
      }
      this.ctx = ctx;
      try { ctx.on("close", () => this._onContextClosed(ctx, generation)); } catch {}
      await this.enforcePageCap(MAX_PAGES).catch(() => {});
      return this.ctx;
    })();
    this._opening = promise;
    // finally() returns a new promise that still rejects; swallow only that one so a cancelled launch is not unhandled.
    promise.finally(() => { if (this._opening === promise) this._opening = null; }).catch(() => {});
    return promise;
  }
  /** CDP dropped. On Mac the window is often still on screen — kill that profile's Chrome so it cannot linger. */
  _onContextClosed(ctx, generation) {
    if (this.ctx !== ctx) return;
    this.ctx = null; this.pollPage = null; this.messagesPage = null;
    if (this._generation === generation) reapChromeProcesses(this.profileDir());
  }
  async _launch() {
    const dir = this.profileDir();
    fs.mkdirSync(dir, { recursive: true });
    // A previous pass may have forgotten its window. Reap it before starting another, and
    // drop the saved window list so Chrome cannot restore hundreds of selling pages.
    reapChromeProcesses(dir);
    try { calmChromeProfile(dir); } catch (e) { this.o.log?.("⚠ profile reset: " + e.message); }
    try {
      return await chromium.launchPersistentContext(dir, {
        headless: !!this.o.headless,               // headful by default
        channel: this.o.executablePath ? undefined : "chrome", // installed Google Chrome
        executablePath: this.o.executablePath,
        viewport: null, args: CHROME_ARGS.slice()
      });
    } catch (e) { reapChromeProcesses(dir); throw e; }
  }
  async _abandon(ctx) {
    if (!ctx) return;
    const pages = typeof ctx.pages === "function" ? ctx.pages().slice() : [];
    for (const pg of pages) { if (!pg.isClosed?.()) await pg.close(); }
    await ctx.close();
  }
  /**
   * Close this rep's Chrome for real (quit, sign-out, switching to another rep).
   * If Chrome refuses, keep the handle when the process is still usable so the next
   * pass reuses it, and always kill leftover processes for this profile only.
   */
  async close() {
    if (this._closing) return this._closing;
    const generation = ++this._generation;
    const opening = this._opening;
    this._closing = (async () => {
      if (opening) await opening.catch(() => {});
      if (this._generation !== generation) return;
      const c = this.ctx;
      this.pollPage = null; this.messagesPage = null;
      if (c) {
        try { await this._abandon(c); if (this.ctx === c) this.ctx = null; }
        catch (e) {
          this.o.log?.("⚠ browser close: " + (e.message || e));
          // Chrome ignored the close. Keep the handle so the next pass does not launch a second window.
          if (this._generation === generation) this.ctx = c;
        }
      }
      const killed = reapChromeProcesses(this.profileDir());
      // The OS process is gone. Drop the handle so the next pass can launch exactly one window.
      if (killed.length && this.ctx === c) this.ctx = null;
      else if (this.ctx === c && c && !this._usable(c)) this.ctx = null;
    })().finally(() => { if (this._closing) this._closing = null; });
    return this._closing;
  }

  /** Never let automation pages pile up. Closes every page beyond `max` (oldest kept, newest extras closed),
   *  never the `keep` page or the poll tab. Returns how many were closed. */
  async enforcePageCap(max = MAX_PAGES, keep = null) {
    let closed = 0;
    const alive = p => p && !p.isClosed?.();
    for (let pass = 0; pass < 3; pass++) {
      const pages = (this.ctx?.pages() || []).filter(alive);
      if (pages.length <= max) break;
      const keepSet = new Set([pages[0], keep, this.pollPage].filter(Boolean));
      const victims = pages.filter(p => !keepSet.has(p));
      if (!victims.length) break;
      const need = pages.length - max;
      let progressed = false;
      for (const pg of victims.slice().reverse().slice(0, need)) {
        try { await pg.close(); progressed = true; closed++; } catch { /* still open; another pass retries */ }
      }
      if (!progressed) break;
    }
    if (closed) this.o.log?.(`🧹 closed ${closed} extra browser tab(s) (cap ${max})`);
    return closed;
  }
  /** One reusable tab for background checks (selling page / delist / status). Uses the window Chrome already opened. */
  async getPollPage() {
    const c = await this.open();
    const alive = p => p && !p.isClosed?.();
    if (!alive(this.pollPage)) {
      const existing = (typeof c.pages === "function" ? c.pages() : []).filter(alive);
      this.pollPage = existing[0] || await c.newPage();
    }
    await this.enforcePageCap(MAX_PAGES, this.pollPage);
    return this.pollPage;
  }

  /** Opens facebook.com for the one-time login inside this profile. */
  async loginWindow() { const c = await this.open(); const p = c.pages()[0] || await c.newPage(); await p.goto("https://www.facebook.com/"); return p; }

  /** 1.0.10: open THIS rep's own persistent Chrome profile at the Marketplace inbox (already logged in).
   *  Falls back to facebook.com/messages if the inbox page doesn't load. Never touches another rep's folder. */
  async openMessages(fbBase = "https://www.facebook.com", where = "inbox") {
    const base = String(fbBase || "https://www.facebook.com").replace(/\/+$/, "");
    const c = await this.open();
    const alive = p => p && !p.isClosed?.();
    // Reuse one messages tab. A new page on every click became another Chrome window on Mac.
    // Never take over the poll tab or a listing form the rep is looking at.
    if (!alive(this.messagesPage)) this.messagesPage = await c.newPage();
    const p = this.messagesPage;
    if (where === "messages") { await p.goto(base + "/messages/", { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {}); await p.bringToFront().catch(() => {}); await this.enforcePageCap(MAX_PAGES, p); return { ok: true, url: p.url() }; }
    try { await p.goto(base + "/marketplace/inbox/", { waitUntil: "domcontentloaded", timeout: 30000 }); }
    catch (e) { this.o.log("⚠ Marketplace inbox didn't load (" + e.message.split("\n")[0] + "); opening Messenger instead"); await p.goto(base + "/messages/", { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {}); }
    await p.bringToFront().catch(() => {});
    await this.enforcePageCap(MAX_PAGES, p);
    return { ok: true, url: p.url() };
  }

  async checkpoint(page) {
    if (/\/checkpoint\//.test(page.url())) return "checkpoint URL";
    const t = (await page.locator("body").innerText().catch(() => "")).toLowerCase().slice(0, 20000);
    return CHECKPOINT_TEXT.find(x => t.includes(x)) || null;
  }

  // Resilient finders: accessible name / visible label text, never FB class names.
  field(page, label) {
    const pat = JSON.stringify(FC.labelPattern(label));   // 1.0.12: colour/color, case, spacing tolerant
    return page.getByLabel(FC.labelRegex(label)).or(page.locator(`label:has(span:text-matches(${pat}, "i")) :is(input,textarea)`)).first();
  }
  async fill(page, label, value) {
    if (value == null || value === "") return;
    const el = this.field(page, label);
    if (!(await el.count())) return this.o.log(`⚠ field "${label}" not found - fill manually`);
    await el.click(); await el.fill(String(value)); this.o.log(`✓ ${label}`); await jitter(300, 900);
  }
  async choose(page, label, option, type = false) {
    const pat = JSON.stringify(FC.labelPattern(label));   // 1.0.12: "Exterior colour" (UK) == "Exterior color"
    const combo = page.getByRole("combobox", { name: FC.labelPrefixRegex(label) }).or(page.locator(`[role=combobox]:has(span:text-matches(${pat}, "i")), label[aria-haspopup]:has(span:text-matches(${pat}, "i"))`)).first();
    if (!(await combo.count())) { this.o.log(`⚠ dropdown "${label}" not found - choose "${option}" manually`); return false; }
    await combo.click(); await jitter(400, 900);
    if (type) await page.keyboard.type(String(option), { delay: 60 });
    let opt = null, picked = option;   // 1.0.12: also try UK/US spellings (Gray/Grey)
    for (const alt of FC.optionAlternates(option)) {
      const o = page.getByRole("option", { name: alt, exact: true }).or(page.getByRole("option", { name: alt })).first();
      if (await o.count()) { opt = o; picked = alt; break; }
    }
    if (!opt) { this.o.log(`⚠ option "${option}" not in "${label}"`); await page.keyboard.press("Escape"); return false; }
    await opt.click(); this.o.log(`✓ ${label}: ${picked}`); await jitter(400, 900); return true;
  }

  /** Fill + (optionally) publish on the VEHICLE form (Vehicle type = Trailer). Never uses the item form.
   *  Returns {outcome, marketplace_url?, groups_shared?, error?} */
  async post(job, s) {
    const p = job.payload, c = await this.open(), page = await c.newPage();
    const url = s.formUrlOverride || FC.vehicleFormUrl(s.fbBase);
    await page.goto(url, { waitUntil: "domcontentloaded" });
    if (!s.formUrlOverride && !FC.isVehicleForm(page.url()) && !FC.isEditForm(page.url()) && !(await this.checkpoint(page)))
      return this.fail(page, `Facebook redirected away from the vehicle form (${page.url()}). Not posted.`);
    await page.locator('input[type=file]').first().waitFor({ state: "attached", timeout: 30000 }).catch(() => {});
    let cp = await this.checkpoint(page); if (cp) return { outcome: "CHECKPOINT", error: cp };
    // Photos: Playwright sets files natively on the hidden input (downloaded to temp first).
    const files = await this.download(p.photos || []);
    if (!files.length && this.skippedPlaceholders) return this.fail(page, `HOLD: no real photos - only placeholder/stock image(s) ("Coming soon") in DealerOS for this unit. Add real photos, then requeue.`);
    if (!files.length) return this.fail(page, `No photo could be downloaded (${(p.photos || []).length} URL(s) in the job${this.lastPhotoErrors?.length ? ": " + this.lastPhotoErrors.slice(0, 3).join("; ") : ""})`);
    await page.locator('input[type=file][accept*=image], input[type=file]').first().setInputFiles(files);
    this.o.log(`✓ ${files.length} photos`); await jitter(2000, 4000);
    // VIN first (Facebook's first field): FB decodes it and may rewrite type/year/make/model (e.g. to a car).
    // Everything below then overwrites those with DealerOS values, starting with Vehicle type = Trailer.
    // 1.0.8 (Samuel): NEVER type the VIN into Facebook's VIN box - Facebook decodes it as a car (Car/Truck, "EX-L").
    // The VIN goes in the description only; if Facebook prefills the VIN box, clear it.
    await this.choose(page, "Vehicle type", "Trailer");
    await this.clearVin(page);
    if (!(await this.choose(page, "Vehicle type", "Trailer")))
      return this.fail(page, 'Vehicle form: "Trailer" not offered in Vehicle type. Not posted (no fallback to the item form).');
    if (p.year) { if (!(await this.choose(page, "Year", String(p.year)))) await this.fill(page, "Year", p.year); }
    const makeCombo = await page.getByRole("combobox", { name: "Make" }).count();
    if (makeCombo) {
      if (!(await this.choose(page, "Make", p.make, true))) {
        if (p.unknown_make !== "OTHER") { await page.close(); return { outcome: "HOLD_UNMAPPED_MAKE", make: p.make }; }
        await this.choose(page, "Make", "Other", true);
      }
    } else await this.fill(page, "Make", p.make);
    await this.overwrite(page, "Model", p.model);
    await this.clearTrim(page);   // a VIN decode can leave a trim (e.g. "EX-L") that Facebook appends to the title
    // Required on the vehicle form: Exterior + Interior color (mapped server-side; default Black). Transmission is never set.
    // 1.0.10: Exterior color comes from the unit's color field(s) or its description (synonyms mapped, e.g. charcoal -> Gray,
    // pewter -> Silver). Nothing found -> same as before (server value, else Black).
    const ext = exteriorColor(p), extColor = ext ? ext.color : (p.exterior_color || "Black");
    if (ext) this.o.log(`exterior color "${ext.color}" (from ${ext.source})`);
    if (!(await this.choose(page, "Exterior color", extColor))) await this.choose(page, "Exterior color", p.exterior_color && p.exterior_color !== extColor ? p.exterior_color : "Black") || await this.choose(page, "Exterior color", "Black");
    if (!(await this.choose(page, "Interior color", p.interior_color || "Black"))) await this.choose(page, "Interior color", "Black");
    if (await page.getByLabel(FC.labelRegex("Mileage")).count()) await this.fill(page, "Mileage", p.mileage ?? 0);
    await this.fill(page, "Price", p.price);
    await this.fill(page, "Description", FC.descriptionWithVin(p.description, p.vin, s.hideVehicleDetails));
    if (s.location) await this.fill(page, "Location", s.location);
    const missing = FC.missingFields(await page.evaluate(`(() => { ${FC_SRC}; return self.DealerOSFormCheck.snapshot(document); })()`));
    if (missing.length) this.o.log("⚠ still empty after fill: " + missing.join(", "));
    cp = await this.checkpoint(page); if (cp) return { outcome: "CHECKPOINT", error: cp };
    await jitter(1500, 3000);
    const chk = await this.identityCheck(page, p);
    for (const w of chk.warnings) this.o.log("⚠ " + w);
    if (chk.error) return this.fail(page, chk.error);
    if (!s.autoPublish) {   // UI asks the rep to publish + paste URL
      const reason = "Auto publish is OFF (FBMP Settings or your manager's setting): form filled and checked, click Next/Publish yourself.";
      this.o.log("⏸ " + reason); return { outcome: "AWAITING_HUMAN", page, reason, warnings: chk.warnings };
    }
    await jitter(1500, 4000);
    await this.clearVin(page);
    const sub = await this.submitForm(page, p, s);
    if (sub.outcome) return sub;
    const { groups_shared } = sub;
    const marketplace_url = await this.findListingUrl(page, p.title);
    this.o.log(marketplace_url ? `✅ Published: ${marketplace_url}` : "✅ Published (listing link not found yet - check Marketplace > Your listings)");
    await page.close().catch(() => {});
    return { outcome: "POSTED", marketplace_url, groups_shared };
  }

  /** 1.0.11: Next -> (groups) -> final Publish/Update/Save, on the create form OR the edit page, with Trailer checks
   *  and a log line per step. Returns {groups_shared} when Facebook left the form, else an outcome object. */
  async submitForm(page, p, s) {
    // 1.0.11: works on both the create form and Facebook's EDIT page (/marketplace/edit/?listing_id=...), whose
    // final button is "Update"/"Save" instead of "Publish". Next stays disabled while photos upload: wait for it.
    const isEdit = FC.isEditForm(page.url());
    this.o.log(`▶ auto publish ON - ${isEdit ? "edit page (" + page.url().split("?")[1] + ")" : "create form"}: clicking Next, then ${isEdit ? "Update/Save/Publish" : "Publish"}`);
    let vt = await this.verifyTrailer(page, "before Next"); if (vt) return this.fail(page, vt);
    const b1 = await this.waitForButton(page, ["Next", ...FC.FINAL_BUTTONS], s.buttonWaitMs ?? 90000);
    if (!b1) return this.fail(page, `No Next/${FC.FINAL_BUTTONS.join("/")} button found on the ${isEdit ? "edit page" : "form"} - check the window; not published.`);
    if (b1.disabled) { this.o.log(`⛔ ${b1.name} still disabled after waiting; snapshot ${JSON.stringify(b1.snap)}`); return this.fail(page, FC.disabledReason(b1.snap, b1.name)); }
    if (/^next$/i.test(b1.name)) {
      try { await this.clickButton(page, "Next"); this.o.log("✓ clicked Next"); }
      catch (e) { return this.fail(page, "Next button could not be clicked: " + String(e.message).split("\n")[0]); }
      await jitter(2500, 5000);
    } else this.o.log(`ℹ no Next step - ${b1.name} is on this page`);
    const groups_shared = await this.shareGroups(page, p.groups || [], s);
    vt = await this.verifyTrailer(page, `before ${isEdit ? "Update" : "Publish"} (review screen)`); if (vt) return this.fail(page, vt);
    const b2 = await this.waitForButton(page, FC.FINAL_BUTTONS, s.buttonWaitMs ?? 90000);
    if (!b2) { const reason = `No ${FC.FINAL_BUTTONS.join("/")} button appeared after Next - finish it in the window.`; this.o.log("⏸ " + reason); return { outcome: "AWAITING_HUMAN", page, groups_shared, reason }; }
    if (b2.disabled) { this.o.log(`⛔ ${b2.name} still disabled after waiting; snapshot ${JSON.stringify(b2.snap)}`); return this.fail(page, FC.disabledReason(b2.snap, b2.name)); }
    const formUrl = page.url();
    try { await this.clickButton(page, b2.name); this.o.log(`✓ clicked ${b2.name}`); }
    catch (e) { return this.fail(page, `${b2.name} button could not be clicked: ` + String(e.message).split("\n")[0]); }
    let left = false;
    for (let i = 0; i < 45; i++) {
      await sleep(1000);
      const cp = await this.checkpoint(page); if (cp) return { outcome: "CHECKPOINT", error: cp };
      const u = page.url();
      if (!FC.isFormUrl(u) && (!s.formUrlOverride || u !== formUrl)) { left = true; break; }
    }
    if (!left) return this.fail(page, `Clicked ${b2.name} but Facebook stayed on the ${isEdit ? "edit page" : "create form"} after 45s - check the window; not marked posted.`);
    this.o.log(`✓ Facebook left the form after ${b2.name} (${page.url().slice(0, 80)})`);
    return { groups_shared };
  }

  /** 1.0.11: wait until one of the VISIBLE buttons (first matching name in `names` order) is enabled.
   *  Returns {name, disabled:false} as soon as one is enabled, {name, disabled:true, snap} at timeout, or null if none exists. */
  async waitForButton(page, names, timeoutMs = 90000) {
    const t0 = Date.now(); let logged = false, last = null;
    while (true) {
      const st = await page.evaluate(`(() => { ${FC_SRC}; const FC = self.DealerOSFormCheck; const b = FC.findVisibleButton(document, ${JSON.stringify(names)});
        return b ? { name: (b.getAttribute("aria-label") || b.textContent || "").trim(), disabled: FC.isDisabled(b), snap: FC.snapshot(document) } : null; })()`).catch(() => null);
      if (st && !st.disabled) { if (logged) this.o.log(`✓ ${st.name} enabled after ${Math.round((Date.now() - t0) / 1000)}s`); return st; }
      if (st) last = st;
      if (st && !logged) { this.o.log(`⏳ ${st.name} is disabled - waiting for Facebook (photos uploading / validating)…`); logged = true; }
      if (Date.now() - t0 >= timeoutMs) return last;
      await sleep(1500);
    }
  }
  async clickButton(page, name) {
    const re = new RegExp("^\\s*" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*$", "i");
    const loc = page.getByRole("button", { name: re });
    const n = await loc.count();
    for (let i = 0; i < n; i++) { const b = loc.nth(i); if (await b.isVisible().catch(() => false)) return b.click({ timeout: 15000 }); }
    return loc.first().click({ timeout: 15000 });
  }

  /** If the first matching Next/Publish button is disabled, wait a little (FB validates async), then explain why. */
  async disabledCheck(page, ...names) {
    for (let i = 0; i < 3; i++) {
      // String expression (CDP Runtime.evaluate) so it is not subject to the page's eval CSP.
      const st = await page.evaluate(`(() => { ${FC_SRC}; const FC = self.DealerOSFormCheck; const b = FC.findButton(document, ...${JSON.stringify(names)});
        return b ? { name: (b.getAttribute("aria-label") || b.textContent || "").trim(), disabled: FC.isDisabled(b), snap: FC.snapshot(document) } : null; })()`);
      if (!st || !st.disabled) return null;
      if (i === 2) { this.o.log(`⛔ ${st.name} disabled; snapshot ${JSON.stringify(st.snap)}`); return FC.disabledReason(st.snap, st.name); }
      await sleep(1500);
    }
    return null;
  }
  /** Select-all + replace (or clear) a text field so decoded leftovers can't survive. Missing field: no-op. */
  async overwrite(page, label, value) {
    const el = this.field(page, label);
    if (!(await el.count())) return false;
    await el.click().catch(() => {}); await el.fill("").catch(() => {});
    await page.keyboard.press("Control+A").catch(() => {}); await page.keyboard.press("Backspace").catch(() => {});
    if (value != null && value !== "") await el.fill(String(value));
    const got = await el.inputValue().catch(() => "");
    this.o.log(value ? `✓ ${label}` : got ? `⚠ ${label} still "${got}"` : `✓ ${label} cleared`); await jitter(300, 800);
    return true;
  }
  /** Trim may be a text box or a dropdown with any label containing "Trim". Clear it / pick a blank option; log what was found. */
  async clearTrim(page) {
    const cands = [page.getByRole("combobox", { name: /trim/i }), page.getByLabel(/^\s*trim\b/i), page.locator('label:has(span:text-matches("^trim", "i")) :is(input,[role=combobox])')];
    let el = null; for (const c of cands) if (await c.count().catch(() => 0)) { el = c.first(); break; }
    if (!el) { this.o.log("ℹ no Trim field visible on the form"); return { status: "NO_FIELD" }; }
    const isCombo = (await el.getAttribute("role").catch(() => null)) === "combobox" && !(await el.evaluate(e => /^(INPUT|TEXTAREA)$/.test(e.tagName)).catch(() => false));
    if (!isCombo) {
      const before = await el.inputValue({ timeout: 3000 }).catch(() => "");
      await el.fill("").catch(() => {}); const after = await el.inputValue({ timeout: 3000 }).catch(() => "");
      this.o.log(after ? `⚠ Trim text box still "${after}"` : `✓ Trim cleared${before ? ` (was "${before}")` : ""}`);
      return { status: after ? "NOT_CLEARED" : "CLEARED", before };
    }
    const before = ((await el.innerText().catch(() => "")) || "").replace(/trim/i, "").trim();
    if (!before) { this.o.log("✓ Trim dropdown empty"); return { status: "EMPTY" }; }
    await el.click().catch(() => {}); await jitter(400, 900);
    const opts = await page.getByRole("option").allInnerTexts().catch(() => []);
    const blank = opts.find(o => /^\s*(none|no trim|base|select|-+|—)\s*$/i.test(o));
    if (blank) { await page.getByRole("option", { name: blank.trim(), exact: true }).first().click().catch(() => {}); this.o.log(`✓ Trim set to "${blank.trim()}" (was "${before}")`); return { status: "CLEARED", before }; }
    await page.keyboard.press("Escape").catch(() => {});
    this.o.log(`⚠ Trim dropdown shows "${before}" and has no blank option (options: ${opts.slice(0, 12).join(" | ")})`);
    return { status: "NOT_CLEARED", before, options: opts.slice(0, 12) };
  }
  /** Actual selected Vehicle type, read three independent ways. */
  async readVehicleType(page) {
    const combo = page.getByRole("combobox", { name: FC.labelPrefixRegex("Vehicle type") }).first();
    let fromCombo = "";
    if (await combo.count().catch(() => 0)) fromCombo = ((await combo.innerText({ timeout: 2000 }).catch(() => "")) || "").replace(/vehicle type/i, "").trim();
    const fromSnap = await page.evaluate(`(() => { ${FC_SRC}; return self.DealerOSFormCheck.snapshot(document).fields["Vehicle type"]; })()`).catch(() => "") || "";
    const carFields = [];
    for (const k of ["Transmission", "Fuel type", "Body style"]) {
      const c = page.getByRole("combobox", { name: FC.labelPrefixRegex(k) }).first();
      if (await c.count().catch(() => 0) && await c.isVisible().catch(() => false)) carFields.push(k);
    }
    const body = (await page.locator("body").innerText({ timeout: 3000 }).catch(() => "")) || "";
    return FC.vehicleTypeVerdict({ fromCombo, fromSnap, carFields, bodyHasCarTruck: /car\s*\/\s*truck/i.test(body), hasCombo: !!fromCombo || !!fromSnap });
  }
  /** Re-verify Trailer several times after the network settles; returns an error string or null. */
  async verifyTrailer(page, stage) {
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    for (let i = 0; i < 3; i++) {
      const st = await this.readVehicleType(page);
      if (!st.isTrailer) { this.o.log(`⛔ ${stage}: ${st.reason}`); return `Vehicle type is not Trailer ${stage}: ${st.reason}. Not published.`; }
      await sleep(1200);
    }
    this.o.log(`✓ Vehicle type is Trailer ${stage}`); return null;
  }
  async vinBox(page) {
    for (const label of FC.VIN_LABELS) {
      const c = page.getByLabel(label, { exact: true }).or(page.locator(`label:has(span:text-is("${label}")) input`)).first();
      if (await c.count()) return c;
    }
    const c = page.getByLabel(/\bVIN\b|vehicle identification/i).first();
    return (await c.count()) ? c : null;
  }
  /** Facebook's VIN box must stay empty (1.0.8). If it holds anything, clear it. */
  async clearVin(page) {
    const el = await this.vinBox(page); if (!el) return { status: "NO_FIELD" };
    const v = await el.inputValue({ timeout: 2000 }).catch(() => "");
    if (!v) return { status: "EMPTY" };
    await el.fill("").catch(() => {});
    const after = await el.inputValue({ timeout: 2000 }).catch(() => "");
    this.o.log(after ? `⚠ could not clear Facebook's VIN box ("${after}")` : `✓ cleared Facebook's VIN box (had "${v}") - VIN stays in the description`);
    return { status: after ? "NOT_CLEARED" : "CLEARED" };
  }
  /** Before Next/Publish: form must be Trailer with DealerOS year/make/model and an empty VIN box. */
  async identityCheck(page, p) {
    const snap = await page.evaluate(`(() => { ${FC_SRC}; return self.DealerOSFormCheck.snapshot(document); })()`);
    const vb = await this.vinBox(page); snap.vinBox = !!vb; snap.vin = vb ? await vb.inputValue().catch(() => "") : "";
    for (const k of ["Transmission", "Fuel type"]) {   // Trailer form usually hides these, but a VIN decode can leave values behind
      const c = page.getByRole("combobox", { name: FC.labelPrefixRegex(k) }).first();
      if (!(await c.count()) || !(await c.isVisible().catch(() => false))) continue;
      snap.fields[k] = FC.stripLabel((await c.innerText().catch(() => "")) || "", k);
      if (k === "Fuel type" && snap.fields[k] && !/^other$/i.test(snap.fields[k]) && await this.choose(page, k, "Other")) snap.fields[k] = "Other";
    }
    const trim = page.getByLabel(/^\s*trim\b/i).or(page.getByRole("combobox", { name: /trim/i })).first();
    if (await trim.count().catch(() => 0)) {
      const t = (await trim.inputValue({ timeout: 2000 }).catch(() => null)) ?? ((await trim.innerText({ timeout: 2000 }).catch(() => "")) || "").replace(/trim/i, "").trim();
      if (t) snap.fields.Trim = t;
    }
    // Title preview: short one-line texts that start with the year (Facebook builds the title from year/make/model/trim).
    snap.titles = await page.evaluate(y => [...document.querySelectorAll("span,div,h1,h2,h3")]
      .filter(e => !e.children.length && !e.closest("textarea,[contenteditable=true]")).map(e => (e.textContent || "").trim())
      .filter(t => t && t.length <= 120 && !t.includes("\n") && t.startsWith(String(y))), String(p.year || "")).catch(() => []);
    const r = FC.identityCheck(snap, p);
    return { error: r.blockers.length ? "Facebook's form does not match DealerOS: " + r.blockers.join("; ") + ". Not published." : null, warnings: r.warnings };
  }
  /** After Publish Facebook usually lands on /marketplace/you/selling, not the item page: look the new listing up by title. */
  async findListingUrl(page, title) {
    const ITEM = /\/marketplace\/item\/(\d+)/;   // FB item page (or a local mock that puts it in the hash)
    const norm = u => { const m = String(u || "").match(ITEM); return m ? `https://www.facebook.com/marketplace/item/${m[1]}/` : ""; };
    if (norm(page.url())) return norm(page.url());
    const t = String(title || "").trim().toLowerCase().slice(0, 40);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (attempt || !/\/marketplace\/you\/selling/.test(page.url()))
          await page.goto((this.o.fbBase || "https://www.facebook.com") + "/marketplace/you/selling", { waitUntil: "domcontentloaded" });
        await sleep(4000 + attempt * 3000);
        const links = await page.locator('a[href*="/marketplace/item/"]').evaluateAll(as => as.map(a => ({ href: a.href, text: (a.innerText || a.getAttribute("aria-label") || "").toLowerCase() })));
        const hit = (t && links.find(l => l.text.includes(t))) || null;
        if (hit) return norm(hit.href);
        // Your-listings tiles may not be links: open the matching tile and read the item link from it.
        if (t) {
          const tile = page.getByText(title, { exact: false }).first();
          if (await tile.count()) {
            await tile.click({ timeout: 5000 }).catch(() => {}); await sleep(2500);
            if (norm(page.url())) return norm(page.url());
            const inner = await page.locator('a[href*="/marketplace/item/"]').first().getAttribute("href").catch(() => null);
            if (norm(inner ? new URL(inner, "https://www.facebook.com").href : "")) return norm(new URL(inner, "https://www.facebook.com").href);
          }
        }
      } catch (e) { this.o.log("⚠ looking up listing link: " + String(e.message).split("\n")[0]); }
    }
    return "";
  }
  /** Close any extra tabs left open by a crashed run (keeps the first/login tab). */
  async closeStray() { try { for (const pg of (this.ctx?.pages() || []).slice(1)) await pg.close().catch(() => {}); } catch {} }
  async fail(page, error) { this.o.log("⛔ " + error); try { await page.close(); } catch {} return { outcome: "FAILED", error }; }

  // FB only offers groups that accept cross-posts; approval-required/closed groups are absent and skipped.
  async shareGroups(page, groups, s) {
    const shared = [];
    for (const g of groups.slice(0, s.groupBudget ?? s.maxGroupsPerListing)) {
      const box = page.getByRole("checkbox", { name: g.name }).first();
      if (!(await box.count())) { this.o.log(`↷ group "${g.name}" not offered - skipped`); continue; }
      if (!(await box.isChecked().catch(() => false))) await box.click();
      shared.push(g.name); await jitter(400, 1200);
    }
    return shared;
  }

  /** RENEW / REPOST(delete) / DELIST(mark sold) on an existing listing. Auto-click only when autoPublish. */
  /** Read-only: the Facebook groups this rep has joined (name + link), for the dealer's group list. */
  async readJoinedGroups() {
    const c = await this.open(), page = await c.newPage();
    try {
      await page.goto((this.o.fbBase || "https://www.facebook.com") + "/groups/joins/", { waitUntil: "domcontentloaded" });
      await sleep(4000);
      for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, 2500); await sleep(1200); }
      return await page.evaluate(() => {
        const seen = new Set(), out = [];
        for (const a of document.querySelectorAll('a[href*="/groups/"]')) {
          const m = a.href.match(/^https:\/\/www\.facebook\.com\/groups\/([^/?#]+)/);
          const name = (a.textContent || "").trim();
          if (!m || !name || /^(groups|joins|feed|discover|create)$/.test(m[1]) || seen.has(m[1])) continue;
          seen.add(m[1]); out.push({ name: name.slice(0, 200), url: `https://www.facebook.com/groups/${m[1]}/` });
        }
        return out;
      });
    } finally { await page.close().catch(() => {}); await this.enforcePageCap(MAX_PAGES, this.pollPage).catch(() => {}); }
  }

  async listingAction(job, action, s) {
    // The delist poll calls this every few minutes. It used to open a new selling-page window
    // each pass (and 1.0.13 then closed the Playwright handle, so the next pass launched another
    // while the Mac window stayed up). This reuses one tab and always drops extras, including
    // when navigation throws. A checkpoint or a manual step leaves that same tab where it is.
    const page = await this.getPollPage();
    let park = true;
    try {
      await page.goto(job.marketplace_url || s.fbBase + "/marketplace/you/selling");
      const cp = await this.checkpoint(page); if (cp) { park = false; return { outcome: "CHECKPOINT", error: cp }; }
      if (!s.autoPublish) { park = false; return { outcome: "AWAITING_HUMAN" }; }
      const label = { RENEW: /^Renew( listing)?$/, REPOST: /^Delete( listing)?$/, DELIST: /^Mark as sold$/ }[action];
      const btn = page.getByRole("button", { name: label });
      if (!(await btn.count())) { park = false; return { outcome: "AWAITING_HUMAN" }; }
      await btn.first().click(); this.o.log(`✓ clicked ${action === "RENEW" ? "Renew" : action === "REPOST" ? "Delete" : "Mark as sold"}`); await jitter(1500, 3000);
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      if (FC.isEditForm(page.url())) {   // 1.0.11: Facebook sent us to the edit page: finish it (Next + Update/Save) instead of closing it
        this.o.log("ℹ Facebook opened the edit page for this listing - finishing it");
        const sub = await this.submitForm(page, job.payload || {}, s);
        if (sub.outcome) { if (sub.outcome === "AWAITING_HUMAN" || sub.outcome === "CHECKPOINT") park = false; return sub; }
      }
      if (action === "REPOST") { const ok = page.getByRole("button", { name: /^Delete$/ }); if (await ok.count()) await ok.last().click(); }
      return { outcome: { RENEW: "RENEWED", REPOST: "REPOSTED", DELIST: "DELISTED" }[action] };
    } finally {
      if (park && !page.isClosed?.()) await page.goto("about:blank").catch(() => {});
      await this.enforcePageCap(MAX_PAGES, page).catch(() => {});
    }
  }

  /** DealerOS stores uploaded photos as relative /uploads/... paths: resolve them against the DealerOS server. */
  static photoUrl(u, base) {
    const s = String((u && u.url) || u || "").trim(); if (!s) return "";
    if (s.startsWith("//")) return "https:" + s;
    if (/^https?:\/\//i.test(s)) return s;
    try { return new URL(s, String(base || "https://app.dealerosai.ai").replace(/\/+$/, "") + "/").href; } catch { return ""; }
  }
  /** Placeholder / stock images ("COMING SOON" covered-trailer image from the website platform). */
  static isPlaceholder(url, buf, dhash) {
    const u = String(url || "").toLowerCase();
    if (/(coming[-_ ]?soon|placeholder|no[-_]?image|noimage|car_not_found|stock[-_]?photo|photo[-_]?coming)/.test(u)) return "placeholder URL";
    const sha = require("crypto").createHash("sha256").update(buf).digest("hex");
    if (PLACEHOLDER_SHA256.has(sha)) return "known placeholder image";
    if (typeof dhash === "bigint") for (const ref of PLACEHOLDER_DHASH) {
      let x = dhash ^ ref, n = 0; while (x) { n += Number(x & 1n); x >>= 1n; }
      if (n <= 8) return `looks like the "Coming soon" placeholder (dHash distance ${n})`;
    }
    return null;
  }
  async download(urls) {
    const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "dealeros-photos-")), out = [];
    this.lastPhotoErrors = []; this.skippedPlaceholders = 0; const seen = new Set();
    for (const [i, raw] of urls.entries()) {
      const u = Poster.photoUrl(raw, this.o.assetBase);
      try {
        if (!u) throw new Error("empty URL");
        const r = await fetch(u); const type = r.headers.get("content-type") || "";
        if (!r.ok || !type.startsWith("image/")) throw new Error(`HTTP ${r.status} ${type || "no content-type"}`);
        const f = path.join(dir, `photo_${i + 1}.${type.includes("png") ? "png" : type.includes("webp") ? "webp" : "jpg"}`);
        const buf = Buffer.from(await r.arrayBuffer());
        const sha = require("crypto").createHash("sha256").update(buf).digest("hex");
        if (seen.has(sha)) { this.o.log?.(`↷ photo ${i + 1} is a duplicate of an earlier photo - skipped`); continue; }
        seen.add(sha);
        let dh = null; try { dh = this.o.imageDHash ? this.o.imageDHash(buf) : null; } catch {}
        const ph = Poster.isPlaceholder(u, buf, dh);
        if (ph) { this.skippedPlaceholders = (this.skippedPlaceholders || 0) + 1; this.o.log?.(`↷ photo ${i + 1} skipped: ${ph}`); continue; }
        fs.writeFileSync(f, buf); out.push(f);
      } catch (e) { const m = `photo ${i + 1} (${String(raw && raw.url || raw).slice(0, 120)}): ${e.message}`; this.lastPhotoErrors.push(m); this.o.log?.("⚠ " + m); }
    }
    return out;
  }
}
// Facebook sets the tab title to "(12) Facebook" when there are unread notifications.
// 1.0.17 stored that title as the account label, and outbound intake used it as the sender.
function facebookProfileName(heading, title) {
  const clean = s => String(s || "").replace(/\s+/g, " ").trim();
  const h = clean(heading);
  const t = clean(String(title || "").replace(/\s*\|\s*Facebook\s*$/i, ""));
  const notify = /^\(\d+\)\s*facebook$/i;
  const pick = h || t.replace(/^\(\d+\)\s*/, "").trim();
  if (!pick || notify.test(pick) || /^facebook$/i.test(pick)) return "";
  return pick.slice(0, 80);
}

function threadUrl(href, base, allowFile) {
  if (!href) return "";
  let u;
  try { u = new URL(href, base || "https://www.facebook.com"); }
  catch { return ""; }
  const host = u.hostname.toLowerCase();
  const facebook = host === "facebook.com" || host.endsWith(".facebook.com");
  if (u.protocol === "file:") return allowFile ? u.href : "";
  if ((u.protocol === "https:" || u.protocol === "http:") && facebook) return u.href;
  return "";
}

module.exports = { Poster, CHECKPOINT_TEXT, MAX_PAGES, CHROME_ARGS, calmChromeProfile, commandUsesProfile, reapChromeProcesses, isAppChromeProfile, facebookProfileName, threadUrl };

// ---------------- Facebook connect + read-only lead capture ----------------
Poster.prototype.connectFacebook = async function (timeoutMs = 10 * 60000) {
  // Opens the visible profile at facebook.com/login; the rep signs in by hand (incl. 2FA).
  const c = await this.open(), page = c.pages()[0] || await c.newPage();
  await page.goto((this.o.fbBase || "https://www.facebook.com") + "/login");
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await this.checkpoint(page)) { await sleep(3000); continue; }      // let the rep finish FB's own checks
    const loggedIn = !/\/login|\/checkpoint|two_step/.test(page.url()) &&
      (await page.locator('[aria-label="Your profile"], [aria-label="Account controls and settings"], [role="navigation"] a[href*="/me"]').count()) > 0;
    if (loggedIn) {
      await page.goto((this.o.fbBase || "https://www.facebook.com") + "/me", { waitUntil: "domcontentloaded" });
      await sleep(1500);
      const url = page.url();
      const id = (url.match(/[?&]id=(\d+)/) || [])[1] || (url.match(/facebook\.com\/([^/?#]+)/) || [])[1] || null;
      const heading = (await page.locator("h1").first().innerText().catch(() => "")).trim();
      const name = facebookProfileName(heading, await page.title());
      if (!name) throw new Error("Couldn't read the Facebook profile name. Open your profile and try Connect again.");
      return { fb_name: name, fb_user_id: id };
    }
    await sleep(2000);
  }
  throw new Error("Facebook login not completed in time");
};

// Runs parseInbox in the page. The function source is sent as text; it does not close over Node.
Poster.prototype.evalInbox = function (page, opts) {
  const src = parseInbox.toString();
  return page.evaluate("(() => { const parseInbox = " + src + "; return parseInbox(" + JSON.stringify(opts || {}) + "); })()");
};

Poster.prototype.packThread = function (open, row) {
  if (!open || open.rejected) return null;
  const thread_id = String((open.thread_id || (row && row.thread_id) || "")).trim();
  if (!thread_id) return null;
  const messages = (Array.isArray(open.messages) ? open.messages : []).filter(m => m && String(m.text || "").trim());
  if (!messages.length) return null;
  const buyer = String((open.buyer_name || (row && row.buyer_name) || "")).trim();
  return {
    thread_id,
    buyer_name: buyer,
    listing_url: String(open.listing_url || ""),
    messages: messages.map(m => ({ text: String(m.text).trim(), time: m.time || null, direction: m.direction === "OUTBOUND" ? "OUTBOUND" : "INBOUND" })),
  };
};

// READ-ONLY: never types, never clicks, never sends. Returns [{thread_id,buyer_name,listing_url,messages:[{text,time,direction}]}]
Poster.prototype.readLeadThreads = async function ({ inboxUrl, maxThreads = 15 } = {}) {
  // Same window as the selling-page check. A new page here was another Chrome window every lead poll.
  const page = await this.getPollPage();
  let park = true;
  try {
    const inbox = inboxUrl || (this.o.fbBase || "https://www.facebook.com") + "/marketplace/inbox/";
    await page.goto(inbox, { waitUntil: "domcontentloaded" });
    await sleep(3000);
    const cp = await this.checkpoint(page); if (cp) { park = false; return { checkpoint: cp, threads: [] }; }
    const listed = await this.evalInbox(page, { mode: "list" });
    const conversations = listed && Array.isArray(listed.conversations) ? listed.conversations : [];
    const allowFile = /^file:/i.test(String(inbox));
    const siblingNames = conversations.map(c => c && c.buyer_name).filter(Boolean);
    const threads = [];
    const targets = conversations.filter(c => c && c.thread_id).slice(0, maxThreads);
    const readOpen = async (row) => {
      const open = await this.evalInbox(page, {
        mode: "open", pageUrl: page.url(), siblingNames,
        expectedId: row && row.thread_id, expectedName: row && row.buyer_name,
      });
      return this.packThread(open, row);
    };
    // No per-conversation id in the list: read only the thread that is already open.
    // Do not invent one shared id for the chat-list names.
    if (!targets.length) {
      const one = await readOpen(null);
      if (one) threads.push(one);
      return { threads };
    }
    const base = page.url();
    for (const c of targets) {
      const dest = threadUrl(c.href, base, allowFile) ||
        threadUrl((this.o.fbBase || "https://www.facebook.com").replace(/\/+$/, "") + "/marketplace/inbox/?thread_id=" + encodeURIComponent(c.thread_id), base, allowFile);
      if (!dest) continue;
      await page.goto(dest, { waitUntil: "domcontentloaded" });
      await jitter(1500, 3000);
      const mid = await this.checkpoint(page);
      if (mid) { park = false; return { checkpoint: mid, threads: [] }; }
      const one = await readOpen(c);
      if (one) threads.push(one);
    }
    return { threads };
  } finally {
    if (park && !page.isClosed?.()) await page.goto("about:blank").catch(() => {});
    await this.enforcePageCap(MAX_PAGES, page).catch(() => {});
  }
};

Poster.prototype.wipeProfile = async function () {
  await this.close();
  fs.rmSync(path.join(this.o.profilesDir, "account-" + this.o.accountId), { recursive: true, force: true });
};
