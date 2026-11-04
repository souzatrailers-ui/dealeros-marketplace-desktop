// Marketplace vehicle-form rules (Samuel, 2026-10-10): trailers ALWAYS go to Vehicle > Trailer
// (facebook.com/marketplace/create/vehicle), never the item form. If Next/Publish stays disabled,
// find which required field is empty and FAIL the job with that reason (no fallback to the item form).
// Pure + DOM helpers; works in Node (desktop/tests), page.evaluate (Playwright) and the extension content script.
(function (root) {
  const VEHICLE_FORM_PATH = "/marketplace/create/vehicle";
  const REQUIRED = ["Photos", "Vehicle type", "Location", "Year", "Make", "Model", "Exterior color", "Interior color", "Price", "Description"];
  const OPTIONAL_IF_PRESENT = ["Mileage"];          // only checked when Facebook shows the field
  const FB_COLORS = ["Black", "Blue", "Brown", "Gold", "Green", "Gray", "Pink", "Purple", "Red", "Silver", "Orange",
    "White", "Yellow", "Charcoal", "Off white", "Tan", "Beige", "Burgundy", "Turquoise"];

  function vehicleFormUrl(base) { return String(base || "https://www.facebook.com").replace(/\/+$/, "") + VEHICLE_FORM_PATH; }
  // 1.0.11: Facebook may open (or redirect to) the EDIT page of a listing/draft; its last button is Update/Save.
  const FINAL_BUTTONS = ["Publish", "Post", "Update", "Update listing", "Save", "Save changes"];
  function isEditForm(u) { return /\/marketplace\/edit\/?(\?|$|#)/.test(String(u || "")) || /\/marketplace\/edit\//.test(String(u || "")); }
  function isFormUrl(u) { return /\/marketplace\/(create|edit)(\/|\?|$)/.test(String(u || "")); }
  function isVisible(el) { return !!el && !el.closest("[hidden],[aria-hidden=true]") && (!el.getClientRects || el.getClientRects().length > 0 || typeof window === "undefined"); }
  /** First VISIBLE button whose label matches names[0], else names[1], ... (order = priority). */
  function findVisibleButton(doc, names) {
    const all = [...doc.querySelectorAll('[role="button"],button')].filter(isVisible);
    for (const n of names) { const re = new RegExp("^\\s*" + n + "\\s*$", "i"); const b = all.find(x => re.test((x.getAttribute("aria-label") || x.textContent || "").trim())); if (b) return b; }
    return null;
  }
  function isVehicleForm(urlOrPath) { return String(urlOrPath || "").includes(VEHICLE_FORM_PATH); }

  /** snapshot = {photos:Number, fields:{Label:value}, vehicleType?:String}. Returns ordered list of missing required fields. */
  function missingFields(snap) {
    const s = snap || {}, f = s.fields || {}, out = [];
    for (const k of REQUIRED) {
      if (k === "Photos") { if (!(Number(s.photos) > 0)) out.push("Photos"); continue; }
      const v = String(f[k] ?? "").trim();
      if (!v || /^(select|choose|year|make|model|vehicle type|exterior colou?r|interior colou?r)\s*\*?$/i.test(v)) out.push(k);
    }
    for (const k of OPTIONAL_IF_PRESENT) if (f[k] !== undefined && f[k] !== null && !String(f[k]).trim()) out.push(k);
    if (f["Vehicle type"] && !/trailer/i.test(String(f["Vehicle type"])) && !out.includes("Vehicle type")) out.push("Vehicle type (must be Trailer)");
    return out;
  }
  function disabledReason(snap, button) {
    const miss = missingFields(snap);
    return `Facebook kept the vehicle form's ${button || "Next"} button disabled. ` +
      (miss.length ? `Required field(s) empty: ${miss.join(", ")}.` : "No empty field detected; check the form for a Facebook error message.") +
      " Not posted (no fallback to the item form).";
  }

  // ---------- DOM side (runs in the page) ----------
  function isDisabled(btn) { return !!btn && (btn.disabled === true || btn.getAttribute("aria-disabled") === "true"); }
  function findButton(doc, ...names) {
    const re = new RegExp("^(" + names.join("|") + ")$", "i");
    return [...doc.querySelectorAll('[role="button"],button')].find(b => re.test((b.getAttribute("aria-label") || b.textContent || "").trim())) || null;
  }
  // 1.0.12: tolerant label matching (UK/US spelling, case, spacing, "*"/"(optional)" suffixes).
  // "Exterior color" also matches "Exterior colour", "exterior  COLOR *", "Exterior colour (optional)".
  function labelPattern(label) {
    const core = String(label).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/colou?r/gi, "colou?r").replace(/\s+/g, "\\s+");
    return "^\\s*" + core + "\\s*\\*?\\s*(?:\\(optional\\))?\\s*$";
  }
  function labelRegex(label) { return new RegExp(labelPattern(label), "i"); }
  /** Accessible names of comboboxes can include the chosen value ("Exterior colour Grey"): match the label as a prefix. */
  function labelPrefixRegex(label) { return new RegExp(labelPattern(label).replace(/\\s\*\\\*\?\\s\*\(\?:\\\(optional\\\)\)\?\\s\*\$$/, "(?![a-z])"), "i"); }
  /** UK/US spellings of option names (Facebook UK lists "Grey"). */
  function optionAlternates(option) {
    const o = String(option), out = [o];
    if (/gray/i.test(o)) out.push(o.replace(/gray/i, m => m[0] === "G" ? "Grey" : "grey"));
    if (/grey/i.test(o)) out.push(o.replace(/grey/i, m => m[0] === "G" ? "Gray" : "gray"));
    if (/colou?r/i.test(o)) out.push(o.replace(/colour/i, "color"), o.replace(/color\b/i, "colour"));
    return [...new Set(out)];
  }
  /** Remove the label words from a combobox's text to get its value ("Exterior colour Grey" -> "Grey"). */
  function stripLabel(text, label) {
    const core = String(label).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/colou?r/gi, "colou?r").replace(/\s+/g, "\\s+");
    return String(text || "").replace(new RegExp(core + "\\s*\\*?(?:\\s*\\(optional\\))?", "i"), "").trim();
  }
  function labelledValue(doc, label) {
    const re = labelRegex(label);
    for (const el of doc.querySelectorAll("input,textarea,[role=combobox]")) {
      const aria = el.getAttribute("aria-label") || "";
      const byId = el.getAttribute("aria-labelledby") && doc.getElementById(el.getAttribute("aria-labelledby"));
      const wrapLabel = el.closest("label");
      const text = aria || (byId && byId.textContent) || (wrapLabel && (wrapLabel.querySelector("span") || wrapLabel).textContent) || "";
      if (!re.test(text.trim())) continue;
      if (el.getAttribute("role") === "combobox" && !/^(input|textarea)$/i.test(el.tagName)) {
        const sel = el.querySelector("[data-value],span:last-child");
        const v = (el.getAttribute("data-value") || (sel && sel.textContent) || el.textContent || "");
        return stripLabel(v, label);
      }
      return el.value || "";
    }
    return null;   // field not on the form
  }
  function snapshot(doc) {
    const fileInput = doc.querySelector('input[type=file]');
    const thumbs = doc.querySelectorAll('img[src^="blob:"], [data-dealeros-photo]').length;
    const photos = Math.max(thumbs, (fileInput && fileInput.files && fileInput.files.length) || 0);
    const fields = {};
    for (const k of REQUIRED) if (k !== "Photos") fields[k] = labelledValue(doc, k) || "";
    for (const k of OPTIONAL_IF_PRESENT) fields[k] = labelledValue(doc, k);
    return { photos, fields };
  }
  // ---------- VIN (payload field "vin" from DealerOS build_payload) ----------
  const VIN_LABELS = ["VIN", "Vehicle identification number (VIN)", "Vehicle identification number", "VIN (optional)"];
  function normalizeVin(v) { return String(v ?? "").toUpperCase().replace(/[^A-Z0-9]/g, ""); }
  /** 17-char modern VIN (no I/O/Q). Trailers can carry shorter/homemade serials: those are still filled, just flagged. */
  function isStandardVin(v) { return /^[A-HJ-NPR-Z0-9]{17}$/.test(normalizeVin(v)); }
  /** Adds "VIN: X" after the first paragraph unless the text already shows it or details are hidden. */
  function descriptionWithVin(desc, vin, hide) {
    const v = normalizeVin(vin), d = String(desc || "");
    if (!v || hide || d.toUpperCase().replace(/[^A-Z0-9]/g, "").includes(v)) return d;
    const parts = d.split(/\n\s*\n/);
    if (parts.length < 2) return d ? d + "\nVIN: " + v : "VIN: " + v;
    parts[0] = parts[0] + "\nVIN: " + v; return parts.join("\n\n");
  }
  /** Facebook's form must still say Trailer + DealerOS year/make/model (a VIN decode can silently turn it into a car). */
  function identityMismatches(snap, p) {
    const f = (snap && snap.fields) || {}, out = [], n = v => String(v ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!/trailer/i.test(String(f["Vehicle type"] || ""))) out.push(`Vehicle type is "${f["Vehicle type"] || "empty"}", not Trailer`);
    if (p.year && n(f.Year) !== n(p.year)) out.push(`Year is "${f.Year || "empty"}", DealerOS has ${p.year}`);
    const fm = n(f.Make);
    if (p.make && fm !== n(p.make) && !(fm === "other" && p.unknown_make === "OTHER")) out.push(`Make is "${f.Make || "empty"}", DealerOS has ${p.make}`);
    if (p.model && n(f.Model) !== n(p.model)) out.push(`Model is "${f.Model || "empty"}", DealerOS has ${p.model}`);
    if (snap && snap.vinBox && String(snap.vin || "").trim()) out.push(`Facebook's VIN box holds "${snap.vin}" (must stay empty - VIN goes in the description only)`);
    return out;
  }
  /** Trailer only if every reading agrees: combobox/snapshot say Trailer (when present), no car-only field is visible,
   *  and on a screen without the dropdown (review) the page does not say "Car/Truck". */
  function vehicleTypeVerdict({ fromCombo = "", fromSnap = "", carFields = [], bodyHasCarTruck = false, hasCombo = true }) {
    const vals = [fromCombo, fromSnap].map(v => String(v || "").trim()).filter(Boolean);
    let reason = null;
    if (hasCombo && !vals.length) reason = "Vehicle type has no selected value";
    else if (vals.some(v => !/trailer/i.test(v))) reason = `Vehicle type reads "${vals.find(v => !/trailer/i.test(v))}"`;
    else if (carFields.length) reason = `car-only fields are visible (${carFields.join(", ")}), so Facebook treats it as a car`;
    else if (!hasCombo && bodyHasCarTruck) reason = 'the review screen says "Car/Truck"';
    return { isTrailer: !reason, reason, value: vals[0] || "", carFields };
  }
  const toks = s => String(s ?? "").toLowerCase().split(/[^a-z0-9.&]+/).map(t => t.replace(/^[.&]+|[.&]+$/g, "")).filter(Boolean);
  function dealerTokens(p) {
    const set = new Set(); for (const v of [p.title, p.year, p.make, p.model, p.category_label, p.category, p.vehicle_type, p.condition, p.price]) for (const t of toks(v)) set.add(t);
    return set;
  }
  function foreignTokens(text, allowed) { return toks(text).filter(t => !allowed.has(t) && !/^\$?[\d,.]+$/.test(t)); }
  /** blockers stop the post; leftovers Facebook keeps hidden on the Trailer form (transmission/fuel/trim) are warnings. */
  function identityCheck(snap, p) {
    const blockers = identityMismatches(snap, p), f = (snap && snap.fields) || {}, warnings = [];
    // 1.0.7: trim and title must contain only DealerOS words (a VIN decode added "EX-L" to live titles).
    const allowed = dealerTokens(p);
    const trimV = String(f.Trim || "").trim();
    if (trimV && !/^(select|choose|none|-+)$/i.test(trimV) && foreignTokens(trimV, allowed).length) blockers.push(`Trim is "${trimV}" (not from DealerOS) - Facebook would add it to the title`);
    const makeT = toks(p.make);
    for (const t of ((snap && snap.titles) || []).filter(t => makeT.every(m => toks(t).includes(m)))) { const extra = foreignTokens(t, allowed); if (extra.length) { blockers.push(`Title preview "${t}" has words not from DealerOS: ${extra.join(" ")}`); break; } }
    for (const k of ["Transmission", "Fuel type"]) {
      const v = String(f[k] || "").trim();
      if (v && !/^(select|choose|other)$/i.test(v)) warnings.push(`${k} "${v}" left over from Facebook's VIN decode (hidden on the Trailer form; check the preview)`);
    }
    return { blockers, warnings };
  }
  const api = { labelPrefixRegex, optionAlternates, labelPattern, labelRegex, stripLabel, FINAL_BUTTONS, isEditForm, isFormUrl, findVisibleButton, vehicleTypeVerdict, dealerTokens, foreignTokens, identityCheck, identityMismatches, VIN_LABELS, normalizeVin, isStandardVin, descriptionWithVin, VEHICLE_FORM_PATH, REQUIRED, OPTIONAL_IF_PRESENT, FB_COLORS, vehicleFormUrl, isVehicleForm, missingFields, disabledReason, isDisabled, findButton, labelledValue, snapshot };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.DealerOSFormCheck = api;
})(typeof self !== "undefined" ? self : this);
