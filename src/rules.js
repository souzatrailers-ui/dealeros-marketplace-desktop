// Shared listing rules + throttling math (pure functions, unit-tested). Works in Node and in the extension (self.DealerOSRules).
// Dealer-specific values (compliance footer, banned phrases, financing-paths line) come from the dealer's
// DealerOS Marketplace profile (server); these are only the generic defaults used when no profile is loaded.
(function (root) {
const RULES = ["Financing, if offered, is subject to approval. No financing is guaranteed."];
const BANNED = ["guaranteed approval", "guaranteed financing", "approved financing", "everyone approved"];
// Compliance rule (all dealers): only text that ASKS for a number is removed; "Finance with Business EIN" offers stay.
const ID_WORDS = "(ssn|itin|ein|social\\s*security(\\s*number)?|tax\\s*id(\\s*number)?|id|driver'?s?\\s*licen[cs]e)";
const ASK_WORDS = "(send|provide|share|dm|pm|message|text|e-?mail|give|bring|enter|submit|upload|include|need(ed)?|requir\\w*|must\\s+have)";
const SENSITIVE_ID = new RegExp("\\b" + ASK_WORDS + "\\b[^.\\n]{0,40}?\\b" + ID_WORDS + "\\b|\\b" + ID_WORDS + "\\b[^.\\n]{0,20}?\\b(required|needed|must\\s+be\\s+provided)\\b", "i");
const FIN_PATHS = /financ\w*\s*(paths?|options?|programs?|available)|clicklease|rent[\s-]*to[\s-]*own|bank\s*loan/i;
/** profile = {compliance_footer:[..], banned_phrases:[..], financing_paths_line:""} from DealerOS (optional). */
function cleanDescription(t, profile) {
  const footer = (profile && profile.compliance_footer && profile.compliance_footer.length) ? profile.compliance_footer : RULES;
  const banned = (profile && profile.banned_phrases) || BANNED;
  const finLine = (profile && profile.financing_paths_line) || "";
  const out = []; let fin = false;
  for (const l of String(t || "").split("\n")) {
    if (banned.some(b => l.toLowerCase().includes(String(b).toLowerCase())) || SENSITIVE_ID.test(l) || footer.includes(l.trim())) continue;
    if (finLine && FIN_PATHS.test(l)) { if (!fin) { out.push(finLine); fin = true; } continue; }
    out.push(l);
  }
  return (out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n\n" + footer.join("\n")).trim();
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

const api = { RULES, BANNED, SENSITIVE_ID, cleanDescription, randomSlots, renewalDue };
if (typeof module !== "undefined" && module.exports) module.exports = api; else root.DealerOSRules = api;
})(typeof self !== "undefined" ? self : this);
