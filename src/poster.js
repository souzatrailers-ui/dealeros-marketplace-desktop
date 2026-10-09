// Playwright posting module. Each Facebook account gets its own persistent profile
// (userDataDir). The salesperson logs in once inside that window; DealerOS never sees
// cookies or passwords. The browser is visible (headful): the human watches each post.
const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright-core");

const CHECKPOINT_TEXT = ["confirm your identity", "we limited how often you can post", "you're temporarily blocked",
  "your account is restricted", "security check", "enter the code", "suspicious activity", "you can't post",
  "help us confirm it's you", "we suspended your account"];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const jitter = (a, b) => sleep(a + Math.random() * (b - a));

class Poster {
  /** opts: { profilesDir, accountId, executablePath?, fbBase, log } */
  constructor(opts) { this.o = opts; this.ctx = null; }

  async open() {
    if (this.ctx) return this.ctx;
    const dir = path.join(this.o.profilesDir, "account-" + this.o.accountId);
    fs.mkdirSync(dir, { recursive: true });
    this.ctx = await chromium.launchPersistentContext(dir, {
      headless: !!this.o.headless,               // headful by default
      channel: this.o.executablePath ? undefined : "chrome", // use installed Google Chrome on Windows
      executablePath: this.o.executablePath,
      viewport: null, args: ["--start-maximized"]
    });
    this.ctx.on("close", () => (this.ctx = null));
    return this.ctx;
  }
  async close() { if (this.ctx) await this.ctx.close(); this.ctx = null; }

  /** Opens facebook.com for the one-time login inside this profile. */
  async loginWindow() { const c = await this.open(); const p = c.pages()[0] || await c.newPage(); await p.goto("https://www.facebook.com/"); return p; }

  async checkpoint(page) {
    if (/\/checkpoint\//.test(page.url())) return "checkpoint URL";
    const t = (await page.locator("body").innerText().catch(() => "")).toLowerCase().slice(0, 20000);
    return CHECKPOINT_TEXT.find(x => t.includes(x)) || null;
  }

  // Resilient finders: accessible name / visible label text, never FB class names.
  field(page, label) {
    return page.getByLabel(label, { exact: true }).or(page.locator(`label:has(span:text-is("${label}")) :is(input,textarea)`)).first();
  }
  async fill(page, label, value) {
    if (value == null || value === "") return;
    const el = this.field(page, label);
    if (!(await el.count())) return this.o.log(`⚠ field "${label}" not found - fill manually`);
    await el.click(); await el.fill(String(value)); this.o.log(`✓ ${label}`); await jitter(300, 900);
  }
  async choose(page, label, option, type = false) {
    const combo = page.getByRole("combobox", { name: label }).or(page.locator(`[role=combobox]:has(span:text-is("${label}")), label[aria-haspopup]:has(span:text-is("${label}"))`)).first();
    if (!(await combo.count())) { this.o.log(`⚠ dropdown "${label}" not found - choose "${option}" manually`); return false; }
    await combo.click(); await jitter(400, 900);
    if (type) await page.keyboard.type(String(option), { delay: 60 });
    const opt = page.getByRole("option", { name: option, exact: true }).or(page.getByRole("option", { name: option })).first();
    if (!(await opt.count())) { this.o.log(`⚠ option "${option}" not in "${label}"`); await page.keyboard.press("Escape"); return false; }
    await opt.click(); this.o.log(`✓ ${label}: ${option}`); await jitter(400, 900); return true;
  }

  /** Fill + (optionally) publish. Returns {outcome, marketplace_url?, groups_shared?, error?} */
  async post(job, s) {
    const p = job.payload, c = await this.open(), page = await c.newPage();
    const url = s.formUrlOverride || s.fbBase + (s.form === "item" ? "/marketplace/create/item" : "/marketplace/create/vehicle");
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.locator('input[type=file]').first().waitFor({ state: "attached", timeout: 30000 }).catch(() => {});
    let cp = await this.checkpoint(page); if (cp) return { outcome: "CHECKPOINT", error: cp };
    // Photos: Playwright sets files natively on the hidden input (downloaded to temp first).
    const files = await this.download(p.photos || []);
    if (!files.length) return { outcome: "FAILED", error: "No real photos available" };
    await page.locator('input[type=file][accept*=image], input[type=file]').first().setInputFiles(files);
    this.o.log(`✓ ${files.length} photos`); await jitter(2000, 4000);
    if (s.form === "item") {
      await this.fill(page, "Title", p.title); await this.fill(page, "Price", p.price);
      await this.choose(page, "Category", p.category || "Trailers", true); await this.choose(page, "Condition", p.condition || "New");
    } else {
      await this.choose(page, "Vehicle type", p.vehicle_type || "Trailer");
      if (p.year) await this.choose(page, "Year", String(p.year));
      const makeCombo = await page.getByRole("combobox", { name: "Make" }).count();
      if (makeCombo) {
        if (!(await this.choose(page, "Make", p.make, true))) {
          if (p.unknown_make === "HOLD") return { outcome: "HOLD_UNMAPPED_MAKE", make: p.make };
          await this.choose(page, "Make", "Other", true);
        }
      } else await this.fill(page, "Make", p.make);
      await this.fill(page, "Model", p.model); await this.fill(page, "Price", p.price);
    }
    await this.fill(page, "Description", p.description);
    if (s.location) await this.fill(page, "Location", s.location);
    cp = await this.checkpoint(page); if (cp) return { outcome: "CHECKPOINT", error: cp };
    if (!s.autoPublish) return { outcome: "AWAITING_HUMAN", page };   // UI asks the rep to publish + paste URL
    await jitter(3000, 8000);
    const next = page.getByRole("button", { name: "Next", exact: true });
    if (await next.count()) { await next.first().click(); await jitter(2500, 5000); }
    const groups_shared = await this.shareGroups(page, p.groups || [], s);
    const pub = page.getByRole("button", { name: /^(Publish|Post)$/ });
    if (!(await pub.count())) return { outcome: "AWAITING_HUMAN", page, groups_shared };
    await pub.first().click();
    for (let i = 0; i < 30; i++) {
      await sleep(1000);
      cp = await this.checkpoint(page); if (cp) return { outcome: "CHECKPOINT", error: cp };
      if (!/\/marketplace\/create/.test(page.url())) break;
    }
    const m = page.url().match(/https:\/\/www\.facebook\.com\/marketplace\/item\/\d+/);
    await page.close();
    return { outcome: "POSTED", marketplace_url: m ? m[0] + "/" : "", groups_shared };
  }

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
  async listingAction(job, action, s) {
    const c = await this.open(), page = await c.newPage();
    await page.goto(job.marketplace_url || s.fbBase + "/marketplace/you/selling");
    const cp = await this.checkpoint(page); if (cp) return { outcome: "CHECKPOINT", error: cp };
    if (!s.autoPublish) return { outcome: "AWAITING_HUMAN", page };
    const label = { RENEW: /^Renew( listing)?$/, REPOST: /^Delete( listing)?$/, DELIST: /^Mark as sold$/ }[action];
    const btn = page.getByRole("button", { name: label });
    if (!(await btn.count())) return { outcome: "AWAITING_HUMAN", page };
    await btn.first().click(); await jitter(1500, 3000);
    if (action === "REPOST") { const ok = page.getByRole("button", { name: /^Delete$/ }); if (await ok.count()) await ok.last().click(); }
    await page.close();
    return { outcome: { RENEW: "RENEWED", REPOST: "REPOSTED", DELIST: "DELISTED" }[action] };
  }

  async download(urls) {
    const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "dealeros-photos-")), out = [];
    for (const [i, u] of urls.entries()) {
      try {
        const r = await fetch(u); const type = r.headers.get("content-type") || "";
        if (!r.ok || !type.startsWith("image/")) continue;
        const f = path.join(dir, `photo_${i + 1}.${type.includes("png") ? "png" : "jpg"}`);
        fs.writeFileSync(f, Buffer.from(await r.arrayBuffer())); out.push(f);
      } catch { /* skip */ }
    }
    return out;
  }
}
module.exports = { Poster, CHECKPOINT_TEXT };

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
      const name = (await page.locator("h1").first().innerText().catch(() => "")).trim() || (await page.title()).replace(/\s*\|\s*Facebook$/, "").trim();
      return { fb_name: name.slice(0, 80), fb_user_id: id };
    }
    await sleep(2000);
  }
  throw new Error("Facebook login not completed in time");
};

// READ-ONLY: never types, never clicks Send. Returns [{thread_id,buyer_name,listing_url,messages:[{text,time,direction}]}]
Poster.prototype.readLeadThreads = async function ({ inboxUrl, maxThreads = 15 } = {}) {
  const c = await this.open(), page = await c.newPage();
  try {
    await page.goto(inboxUrl || (this.o.fbBase || "https://www.facebook.com") + "/marketplace/inbox/", { waitUntil: "domcontentloaded" });
    await sleep(3000);
    const cp = await this.checkpoint(page); if (cp) return { checkpoint: cp, threads: [] };
    const links = await page.locator('a[href*="/messages/t/"], a[href*="/marketplace/t/"]').evaluateAll(as =>
      [...new Set(as.map(a => a.href))].slice(0, 50));
    const threads = [];
    for (const href of links.slice(0, maxThreads)) {
      const thread_id = (href.match(/\/t\/(\d+|[\w.-]+)/) || [])[1]; if (!thread_id) continue;
      await page.goto(href, { waitUntil: "domcontentloaded" }); await jitter(1500, 3000);
      const data = await page.evaluate(() => {
        const listing = [...document.querySelectorAll('a[href*="/marketplace/item/"]')].map(a => a.href)[0] || "";
        const header = document.querySelector('[role="main"] h1, [role="main"] h2, [data-testid="thread-title"]');
        const rows = [...document.querySelectorAll('[role="row"], [data-testid="message-row"]')];
        const messages = rows.map(r => {
          const text = (r.querySelector('[dir="auto"]') || r).innerText.trim();
          const t = r.querySelector("[data-time], time"); const out = r.getAttribute("data-outgoing") === "true" || /You sent/i.test(r.innerText);
          return { text, time: t ? (t.getAttribute("data-time") || t.getAttribute("datetime")) : null, direction: out ? "OUTBOUND" : "INBOUND" };
        }).filter(m => m.text);
        return { listing_url: listing, buyer_name: header ? header.innerText.trim() : "", messages };
      });
      threads.push({ thread_id, ...data, messages: data.messages.map(m => ({ ...m, time: m.time || null })) });
    }
    return { threads };
  } finally { await page.close().catch(() => {}); }
};

Poster.prototype.wipeProfile = async function () {
  await this.close();
  fs.rmSync(path.join(this.o.profilesDir, "account-" + this.o.accountId), { recursive: true, force: true });
};
