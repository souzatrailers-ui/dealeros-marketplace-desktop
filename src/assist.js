// Phase 2 assisted posting for Craigslist and OfferUp.
// Both sites ban automated posting, so this module only: (1) opens the site's own login page in this
// rep's own persistent browser profile (one per channel) so the rep signs in by hand, (2) fills in the
// listing form from the DealerOS task, and (3) WAITS for the rep to review and click Publish/Post.
// It never clicks Publish, never solves CAPTCHAs, never reads or uploads cookies or passwords.
const path = require("path"), fs = require("fs");

const SITES = {
  craigslist: { login: "https://accounts.craigslist.org/login", post: "https://post.craigslist.org/",
    loggedIn: /accounts\.craigslist\.org\/login\/home/, listing: /^https:\/\/[a-z0-9-]+\.craigslist\.org\/(?:[a-z0-9/]+\/)?d\/[^/]+\/\d+\.html/,
    fields: { title: ["input[name=PostingTitle]", "#PostingTitle"], price: ["input[name=price]", "input[name=Ask]"],
      body: ["textarea[name=PostingBody]", "#PostingBody"], vin: ["input[name=auto_vin]"] } },
  offerup: { login: "https://offerup.com/login", post: "https://offerup.com/post",
    loggedIn: /offerup\.com\/(?:$|inbox|accounts|post)/, listing: /^https:\/\/(?:www\.)?offerup\.com\/item\/detail\/[A-Za-z0-9-]+/,
    fields: { title: ["input[name=title]", "input[aria-label*=Title i]"], price: ["input[name=price]", "input[aria-label*=Price i]"],
      body: ["textarea[name=description]", "textarea[aria-label*=Description i]"] } },
};

/** Fields to fill for a task, in order. Pure; used by tests. */
function fillPlan(channel, payload) {
  const site = SITES[channel]; if (!site) throw new Error("Unknown channel " + channel);
  if (!payload || payload.requires_human_click !== true) throw new Error("Assisted tasks must require the rep's click");
  const plan = [["title", payload.title], ["price", String(payload.price || "")], ["body", payload.body]];
  if (site.fields.vin && payload.vin) plan.push(["vin", payload.vin]);
  return plan.filter(([, v]) => v).map(([k, v]) => ({ key: k, selectors: site.fields[k], value: v }));
}
const isListingUrl = (channel, url) => !!(SITES[channel] && SITES[channel].listing.test(String(url || "")));
const profileDir = (repChromeDir, channel) => path.join(repChromeDir, "assist-" + channel);

class AssistPoster {
  /** opts: { repChromeDir, executablePath?, log } */
  constructor(opts) { this.o = opts; this.ctx = {}; }
  async open(channel) {
    if (this.ctx[channel]) return this.ctx[channel];
    const { chromium } = require("playwright-core");
    const dir = profileDir(this.o.repChromeDir, channel); fs.mkdirSync(dir, { recursive: true });
    const ctx = await chromium.launchPersistentContext(dir, { headless: false, channel: this.o.executablePath ? undefined : "chrome",
      executablePath: this.o.executablePath, viewport: null });
    ctx.on("close", () => delete this.ctx[channel]);
    return (this.ctx[channel] = ctx);
  }
  async close() { for (const c of Object.values(this.ctx)) await c.close().catch(() => {}); this.ctx = {}; }
  /** Opens the real login page; resolves with a display name once the rep is signed in (or null after timeout). */
  async connect(channel, timeoutMs = 10 * 60000) {
    const ctx = await this.open(channel), page = ctx.pages()[0] || await ctx.newPage();
    await page.goto(SITES[channel].login);
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (SITES[channel].loggedIn.test(page.url())) return channel === "craigslist" ? "Craigslist account" : "OfferUp account";
      await new Promise(r => setTimeout(r, 2000));
    }
    return null;
  }
  /** Fill the form and wait for the rep's own click. Returns {published, url}. */
  async assist(channel, payload, timeoutMs = 30 * 60000) {
    const plan = fillPlan(channel, payload);
    const ctx = await this.open(channel), page = await ctx.newPage();
    await page.goto(SITES[channel].post);
    this.o.log?.(`[assist] ${channel}: pick the category/area if asked; DealerOS fills the text fields, you click Publish.`);
    const filled = new Set(), end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const url = page.url();
      if (isListingUrl(channel, url)) return { published: true, url };
      for (const f of plan) {
        if (filled.has(f.key)) continue;
        for (const sel of f.selectors) {
          const el = await page.$(sel).catch(() => null);
          if (el) { await el.fill(f.value).catch(() => {}); filled.add(f.key); break; }
        }
      }
      if (page.isClosed()) return { published: false };
      await new Promise(r => setTimeout(r, 1500));
    }
    return { published: false };
  }
}
module.exports = { SITES, fillPlan, isListingUrl, profileDir, AssistPoster };
