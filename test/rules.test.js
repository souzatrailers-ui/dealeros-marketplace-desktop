const test = require("node:test"), assert = require("node:assert");
const { cleanDescription, randomSlots, renewalDue } = require("../src/rules");
test("description rules", () => {
  const d = cleanDescription("Nice\nGuaranteed financing!\nWe deliver");
  assert.ok(!/guaranteed financing|we deliver/i.test(d) && d.includes("Pickup only"));
});
test("random slots inside business hours and apart", () => {
  const from = new Date(2026, 9, 9, 8, 0);
  const s = randomSlots(5, { startHour: 9, endHour: 18, minGapMin: 3 }, from);
  assert.equal(s.length, 5);
  for (const d of s) assert.ok(d.getHours() >= 9 && d.getHours() < 18);
  for (let i = 1; i < s.length; i++) assert.ok(s[i] - s[i - 1] >= 180000);
  assert.deepEqual(randomSlots(3, { startHour: 9, endHour: 18 }, new Date(2026, 9, 9, 19)), []);
});
test("renew methods", () => {
  const now = Date.parse("2026-10-20T12:00:00"), job = { posted_at: "2026-10-12T12:00:00", renew_count: 0 };
  const S = { renewEveryDays: 10, repostEveryDays: 7, maxRenewals: 4 };
  assert.equal(renewalDue(job, { ...S, renewMethod: "REPOST_EVERY_N_DAYS" }, now), "REPOST");
  assert.equal(renewalDue(job, { ...S, renewMethod: "AUTO_RENEW_WEEKLY_4_THEN_REPOST" }, now), "RENEW");
  assert.equal(renewalDue({ ...job, renew_count: 4 }, { ...S, renewMethod: "AUTO_RENEW_WEEKLY_4_THEN_REPOST" }, now), "REPOST");
  assert.equal(renewalDue(job, { ...S, renewMethod: "RENEW_EVERY_N_DAYS_THEN_REPOST" }, now), null);
  assert.equal(renewalDue(job, { ...S, renewMethod: "NONE" }, now), null);
});

const { applyVariant } = require("../src/variants");
const FOOTER = "Pickup only - no delivery.\nFinancing options available; subject to approval. No financing is guaranteed.";
const base = { year: 2026, make: "Lark", model: "7X16TA", category_label: "Enclosed", price: 8999, vin: "V1",
  description: "Great trailer. Available now.\n\nSPECS\n• Size: 7' x 16'\n• GVWR: 7,000 lbs\n\nDOORS\n• Ramp\n\n" + FOOTER,
  photos: ["p0", "p1", "p2", "p3", "p4", "p5", "p6"] };
test("variants deterministic, facts/price/footer invariant, groups partitioned", () => {
  const v = a => applyVariant(base, 1512, a, FOOTER, { name: "Rep" + a, phone: "860" }, [1, 2, 3],
    Array.from({ length: 20 }, (_, i) => ({ name: "G" + i, url: "u" + i })), 100);
  assert.deepEqual(v(1), v(1));
  const seen = new Set();
  for (const a of [1, 2, 3]) {
    const x = v(a);
    assert.equal(x.price, 8999); assert.ok(x.description.endsWith(FOOTER));
    for (const s of ["• Size: 7' x 16'", "• GVWR: 7,000 lbs", "• Ramp"]) assert.ok(x.description.includes(s));
    assert.ok(/2026/.test(x.title) && /Lark/.test(x.title) && /7X16TA/.test(x.title));
    assert.deepEqual([...x.photos].sort(), base.photos); assert.ok(base.photos.slice(0, 4).includes(x.photos[0]));
    for (const g of x.groups) { assert.ok(!seen.has(g.url)); seen.add(g.url); }
  }
  assert.equal(seen.size, 20);
});
