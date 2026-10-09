// End-to-end dry run WITHOUT Facebook: real Souza inventory (mock queue) -> Playwright fills
// the LOCAL mock form (mock/fake-marketplace.html) with photos, groups and auto publish.
const path = require("path"), os = require("os"), fs = require("fs");
const { MockApi } = require("../src/api");
const { Poster } = require("../src/poster");
(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dealeros-mock-"));
  const s = { mock: true, mockInventoryUrl: "https://swtct.com/api/public/dealers/souza-wholesale-trailers/inventory", mockAssetBase: "https://swtct.com",
    autoPost: true, autoPublish: true, form: "vehicle", removeSold: true, renewMethod: "REPOST_EVERY_N_DAYS", repostEveryDays: 7,
    postToGroups: true, groups: [{ name: "Trailers only sale or trade", url: "https://www.facebook.com/groups/583186035035187/" }, { name: "Closed Group", url: "https://www.facebook.com/groups/1/" }],
    maxGroupsPerListing: 5, unknownMake: "OTHER", formUrlOverride: "file://" + path.resolve(__dirname, "../mock/fake-marketplace.html") };
  const api = new MockApi({ dataDir, settings: s });
  const poster = new Poster({ profilesDir: path.join(dataDir, "profiles"), accountId: "mock", headless: true,
    executablePath: process.env.CHROME_PATH, log: m => console.log("  " + m) });
  const st = await api.state(); console.log("counters", st.counters);
  const claim = await api.claim(); console.log("claim", claim.action, claim.job.payload.title, claim.job.payload.photos.length, "photos");
  claim.job.payload.photos = claim.job.payload.photos.slice(0, 3);
  const res = await poster.post(claim.job, s);
  const { page, ...out } = res; console.log("result", out);
  await api.report(claim.job.id, { ...out, outcome: out.outcome === "POSTED" ? "POSTED" : out.outcome, marketplace_url: "https://www.facebook.com/marketplace/item/1234567890/" });
  console.log("counters", (await api.state()).counters);
  const leads = await poster.readLeadThreads({ inboxUrl: "file://" + path.resolve(__dirname, "../mock/fake-inbox.html") });
  console.log("lead threads read (read-only):", JSON.stringify(leads.threads));
  await poster.close();
})().catch(e => { console.error(e); process.exit(1); });
