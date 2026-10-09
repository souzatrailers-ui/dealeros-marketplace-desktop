// Shared listing rules + throttling math (pure functions, unit-tested).
const RULES = ["Pickup only - no delivery.", "Financing options available; subject to approval. No financing is guaranteed."];
const BANNED = ["guaranteed approval", "guaranteed financing", "approved financing", "everyone approved", "we deliver", "free delivery", "delivery available"];

function cleanDescription(t) {
  const lines = String(t || "").split("\n").filter(l => !BANNED.some(b => l.toLowerCase().includes(b)));
  return (lines.join("\n").trim() + "\n\n" + RULES.join("\n")).trim();
}

// Pick N random times today inside [startHour,endHour), at least minGapMin apart, after `from`.
function randomSlots(n, { startHour = 9, endHour = 18, minGapMin = 3 } = {}, from = new Date()) {
  const start = new Date(from); start.setHours(startHour, 0, 0, 0);
  const end = new Date(from); end.setHours(endHour, 0, 0, 0);
  const lo = Math.max(start.getTime(), from.getTime());
  if (end.getTime() <= lo || n <= 0) return [];
  const slots = [];
  for (let tries = 0; slots.length < n && tries < 500; tries++) {
    const t = lo + Math.random() * (end.getTime() - lo);
    if (slots.every(s => Math.abs(s - t) >= minGapMin * 60000)) slots.push(t);
  }
  return slots.sort((a, b) => a - b).map(t => new Date(t));
}

function renewalDue(job, s, now = Date.now()) {
  if (s.renewMethod === "NONE" || !job.posted_at) return null;
  const day = 86400000, posted = new Date(job.posted_at).getTime();
  const last = job.renewed_at ? new Date(job.renewed_at).getTime() : posted;
  if (s.renewMethod === "REPOST_EVERY_N_DAYS") return (now - posted) / day >= s.repostEveryDays ? "REPOST" : null;
  const every = s.renewMethod === "AUTO_RENEW_WEEKLY_4_THEN_REPOST" ? 7 : s.renewEveryDays;
  if ((now - last) / day < every) return null;
  return (job.renew_count || 0) >= s.maxRenewals ? "REPOST" : "RENEW";
}

module.exports = { RULES, BANNED, cleanDescription, randomSlots, renewalDue };
