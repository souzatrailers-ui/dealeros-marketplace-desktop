const test = require("node:test"), assert = require("node:assert");
const fs = require("fs"), path = require("path");
const { fillPlan, isListingUrl, profileDir } = require("../src/assist");
const P = { title: "2025 PJ Dump 7x14", price: 10000, body: "Cash price $10,000 | Card price $10,350", vin: "1ABC", requires_human_click: true };
test("fill plan fills text only and needs the rep's click", () => {
  const plan = fillPlan("craigslist", P);
  assert.deepEqual(plan.map(f => f.key), ["title", "price", "body", "vin"]);
  assert.deepEqual(fillPlan("offerup", P).map(f => f.key), ["title", "price", "body"]);
  assert.throws(() => fillPlan("craigslist", { ...P, requires_human_click: false }));
  assert.throws(() => fillPlan("nextdoor", P));
});
test("published only on the platform's own listing URL", () => {
  assert.ok(isListingUrl("craigslist", "https://orlando.craigslist.org/tro/d/kissimmee-dump/7800000000.html"));
  assert.ok(!isListingUrl("craigslist", "https://post.craigslist.org/k/x/y?s=preview"));
  assert.ok(isListingUrl("offerup", "https://offerup.com/item/detail/abc-123"));
  assert.ok(!isListingUrl("offerup", "https://offerup.com/post"));
});
test("each channel has its own profile per rep and the code never clicks publish", () => {
  assert.notEqual(profileDir("/r/p1/chrome", "craigslist"), profileDir("/r/p1/chrome", "offerup"));
  const src = fs.readFileSync(path.join(__dirname, "../src/assist.js"), "utf8");
  assert.ok(!/\.click\(/.test(src) && !/cookies\(/.test(src) && !/captcha/i.test(src.replace(/never solves CAPTCHAs/, "")));
});
