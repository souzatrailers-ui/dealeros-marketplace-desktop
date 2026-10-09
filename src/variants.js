// Deterministic per-(unit, rep account) listing variation (JS port of app/marketplace_variants.py,
// used in mock mode; in live mode DealerOS sends already-varied payloads).
// Never changes year/make/model, VIN, price, spec lines, or the Souza rules footer; photos only reordered.
(function (root) {
  const TITLES = ["{year} {make} {model} {category}", "{year} {make} {model} {category} Trailer", "{category} Trailer {year} {make} {model}",
    "{year} {make} {model} - {category}", "New {year} {make} {model} {category}"];
  const OPENERS = ["Clean {year} {make} {model} available now.", "Check out this {year} {make} {model}.", "In stock and ready: {year} {make} {model}.",
    "Looking for a solid trailer? This {year} {make} {model} is on the lot.", "Just listed: {year} {make} {model}."];
  const SYN = [["Great", "Excellent", "Solid"], ["Available now", "In stock now", "Ready today"], ["Contact", "Message", "Reach out to"], ["features", "comes with", "includes"]];
  const CLOSERS = ["Message me with any questions.", "Send me a message to come see it.", "Questions? Message me anytime."];
  function rng(seed) { // FNV-1a -> mulberry32
    let h = 2166136261; for (const c of String(seed)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
    let a = h >>> 0; return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  const pick = (r, arr) => arr[Math.floor(r() * arr.length)];
  const shuffle = (r, arr) => { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; };
  const fmt = (t, f) => {
    let out = t.replace(/\{(\w+)\}/g, (_, k) => f[k] ?? "").replace(/\s+/g, " ").trim().replace(/^[- ]+|[- ]+$/g, "");
    out = out.replace(/\b(\w+)(\s+\1\b)+/gi, "$1");                    // "Trailer Trailer" -> "Trailer"
    if ((out.match(/trailer/gi) || []).length > 1) out = out.replace(/\s*\bTrailer\b(?!.*\bTrailer\b)/i, (m, i) => (i === out.length - m.length ? "" : m));
    return out.trim();
  };
  const isFact = l => /\d/.test(l) || /^[•\-*]/.test(l.trim()) || l.includes(":") || (l.trim() && l.trim() === l.trim().toUpperCase());
  function hashIdx(str, n) { return Math.floor(rng(str)() * n); }

  function applyVariant(payload, unitId, accountId, footer, rep = {}, accountIds = [accountId], groups = null, maxGroups = 5) {
    const r = rng(unitId + ":" + accountId), f = { year: payload.year, make: payload.make, model: payload.model, category: payload.category_label || "" };
    let body = payload.description; if (body.endsWith(footer)) body = body.slice(0, -footer.length).trimEnd();
    const paras = body.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean), head = paras.slice(0, 1), rest = shuffle(r, paras.slice(1));
    const out = [...head, ...rest].map(p => p.split("\n").map(ln => {
      if (isFact(ln)) return ln;
      for (const g of SYN) { const w = g.find(x => new RegExp(`\\b${x}\\b`).test(ln)); if (w) return ln.replace(new RegExp(`\\b${w}\\b`), pick(r, g)); }
      return ln;
    }).join("\n"));
    const titles = TITLES.filter(t => !(t.startsWith("New ") && String(payload.condition_raw || "NEW").toUpperCase() !== "NEW"));
    const contact = rep.name || rep.phone ? `${pick(r, CLOSERS)} ${rep.name || ""}${rep.phone ? " - " + rep.phone : ""}`.trim() : "";
    const photos = [...(payload.photos || [])];
    let ordered = photos;
    if (photos.length > 1) { const pool = Math.min(photos.length, 4); const cover = photos[Math.floor(r() * pool)]; ordered = [cover, ...shuffle(r, photos.filter(p => p !== cover))]; }
    const ids = [...accountIds].map(String).sort();
    const mine = groups ? groups.filter(g => ids[hashIdx(g.url + ":" + unitId, ids.length)] === String(accountId)).slice(0, maxGroups) : payload.groups;
    return { ...payload, title: fmt(pick(r, titles), f).slice(0, 99),
      description: [fmt(pick(r, OPENERS), f), ...out, contact, footer].filter(Boolean).join("\n\n"),
      photos: ordered, groups: mine, rep, variant_seed: unitId + ":" + accountId };
  }
  const api = { applyVariant, rng };
  if (typeof module !== "undefined") module.exports = api; else root.DealerOSVariants = api;
})(typeof self !== "undefined" ? self : globalThis);
