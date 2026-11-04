const D = window.dealeros, $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
let cfg, groups = [], chosen = [], awaiting = null, auth = null;

// 1.0.10: any startup/data failure shows a visible message instead of a blank window, and goes to the app log.
function showError(what, e) {
  const msg = `${what}: ${(e && (e.message || e)) || "unknown error"}`;
  try { D.logError && D.logError(msg + (e && e.stack ? "\n" + e.stack : "")); } catch {}
  let b = $("app-error");
  if (!b) { b = document.createElement("div"); b.id = "app-error"; document.body.insertBefore(b, document.body.children[1] || null); }
  b.style.cssText = "background:#fee2e2;color:#991b1b;padding:8px 12px;border-bottom:1px solid #fca5a5;white-space:pre-wrap";
  b.textContent = "⚠ " + msg + "\nThe app is still usable; try switching tabs, Reload, or restart. Details are in the log file (Account → Open logs).";
  b.hidden = false;
}
function clearError() { const b = $("app-error"); if (b) b.hidden = true; }
const SIGN_IN = "Your DealerOS sign-in expired. Sign in again to load the queue.";
function signInMessage(e) {
  const msg = String((e && (e.message || e)) || "");
  if (/Session expired|sign in again|sign-in expired/i.test(msg)) return SIGN_IN;
  return "";
}
function showSignedOut(message) {
  clearError();
  auth = { ...(auth || {}), session: null, signInReason: message || SIGN_IN };
  $("who").textContent = "";
  $("acc-user").textContent = "Signed out";
  $("acc-org").textContent = "";
  $("acc-fb").textContent = "Not connected";
  const note = $("acc-signed-out");
  if (note) { note.hidden = false; note.textContent = auth.signInReason; }
  $("l-err").textContent = "";
  const reason = $("l-reason");
  if (reason) { reason.hidden = false; reason.textContent = auth.signInReason; }
  screen("login");
}
window.addEventListener("error", e => showError("Unexpected error", e.error || e.message));
window.addEventListener("unhandledrejection", e => { const prompt = signInMessage(e.reason); if (prompt) return showSignedOut(prompt); showError("Unexpected error", e.reason); });
// Tabs are bound first so they work even if something later fails.
for (const b of document.querySelectorAll("header button[data-tab]")) b.onclick = () => {
  if ($("login") && !$("login").hidden) return screen("login");
  for (const x of document.querySelectorAll("header button[data-tab]")) x.classList.toggle("on", x === b);
  for (const s of ["queue", "fbmp", "groups", "channels", "accounts"]) { const el = $(s); if (el) el.hidden = s !== b.dataset.tab; }
};
// 1.0.10: Facebook Messages for the selected rep only (main process uses that rep's own Chrome folder).
async function openMsgs(where) {
  const b = $("fb-msgs"); b.disabled = true;
  try { const r = await D.openMessages(where); if (r && r.error) { alert(r.error + (r.fallback ? "\n\nYou can also open " + r.fallback + " in this rep's Facebook window." : "")); }
    else log(`💬 Opened Facebook Messages for ${r.rep || "this rep"}`); }
  catch (e) { showError("Couldn't open Facebook Messages", e); } finally { b.disabled = false; }
}
$("fb-msgs").onclick = () => openMsgs("inbox");
$("fb-msgs-alt").onclick = e => { e.preventDefault(); openMsgs("messages"); };
window.__dealerosRendererReady = true;
function screen(name) { for (const s of ["login", "connect", "app"]) $(s).hidden = s !== name; }
// ----- 1.0.9 rep profiles (each rep: own DealerOS login, own Facebook/Chrome folder, own settings + logs) -----
async function renderProfiles(v) {
  v = v || await D.profiles();
  $("prof").innerHTML = v.profiles.map(p => `<option value="${esc(p.id)}"${p.id === v.active ? " selected" : ""}>${esc(p.name)}${p.user ? " · " + esc(p.user) : " (signed out)"}${p.busy ? " ⏳" : ""}</option>`).join("");
  const h = v.profiles.find(p => p.id === v.gate.holder);
  $("prof-gate").textContent = h ? `Posting: ${h.name}` : v.gate.nextSwitchAt > Date.now() ? `Next rep can start ${new Date(v.gate.nextSwitchAt).toLocaleTimeString()}` : "";
}
$("prof").onchange = async () => { try { await D.switchProfile($("prof").value); } catch (e) { showError("Couldn't switch profile", e); } route(); };
$("prof-add").onclick = async () => { const n = $("prof-name").value.trim(); $("prof-name").value = ""; try { await D.addProfile(n); } catch (e) { showError("Couldn't add the profile", e); } route(); };
$("prof-ren").onclick = async () => { const n = $("prof-name").value.trim(); if (!n) return alert("Type the new name in the box first"); $("prof-name").value = ""; try { await D.renameProfile($("prof").value, n); await renderProfiles(); } catch (e) { showError("Couldn't rename the profile", e); } };
$("prof-del").onclick = async () => {
  if (!confirm("Remove this rep profile from this computer? Its DealerOS sign-in, settings, logs and its Facebook browser folder on this computer are deleted. It is signed out of DealerOS; nothing changes on Facebook or in the rep's DealerOS account.")) return;
  const r = await D.removeProfile($("prof").value); if (r && r.error) return alert(r.error); route().catch(e => showError("Startup failed", e));};
setInterval(() => renderProfiles().catch(() => {}), 20000);
async function route() {
  clearError();
  try { await renderProfiles(); } catch (e) { showError("Couldn't load rep profiles", e); }
  try {
    auth = await D.auth(); cfg = await D.getCfg();
  } catch (e) { showError("Couldn't load this rep's sign-in/settings", e); cfg = cfg || {}; auth = auth || { session: null }; return screen("login"); }
  if (auth.mock) return showApp();
  if (!auth.session) {
    $("who").textContent = "";
    $("acc-user").textContent = "Signed out";
    $("acc-org").textContent = "";
    $("acc-fb").textContent = "Not connected";
    $("l-url").value = auth.apiBase || "https://app.dealerosai.ai";
    const message = auth.signInReason || "";
    const reason = $("l-reason");
    const note = $("acc-signed-out");
    if (message) {
      if (reason) { reason.hidden = false; reason.textContent = message; }
      if (note) { note.hidden = false; note.textContent = message; }
    } else if (reason) { reason.hidden = true; reason.textContent = ""; }
    return screen("login");
  }
  const note = $("acc-signed-out"); if (note) note.hidden = true;
  const reason = $("l-reason"); if (reason) { reason.hidden = true; reason.textContent = ""; }
  if (!(auth.session.facebook_accounts || []).length) return screen("connect");
  return showApp();
}
async function showApp() {
  screen("app");
  try {
  try { groups = await D.groups() || []; } catch (e) { const prompt = signInMessage(e); if (prompt) return showSignedOut(prompt); groups = []; showError("Couldn't load groups", e); }
  chosen = cfg.groups || [];
  const s = auth.session, fb = s?.facebook_accounts?.[0];
  $("who").textContent = auth.mock ? "MOCK MODE" : `${s.user.full_name || s.user.username} · FB: ${fb ? fb.label : "-"}`;
  $("acc-user").textContent = s ? (s.user.full_name || s.user.username) + " (" + (s.user.email || "") + ")" : "mock";
  $("acc-org").textContent = s ? "dealership #" + s.organization_id : ""; $("acc-fb").textContent = fb ? `${fb.label} (${fb.fb_user_id || "id n/a"})` : "not connected";
  for (const el of document.querySelectorAll("[id^=s-]")) { const k = el.id.slice(2); if (el.type === "checkbox") el.checked = !!cfg[k]; else el.value = cfg[k] ?? ""; }
  for (const r of document.querySelectorAll("input[name=renew]")) r.checked = r.value === cfg.renewMethod;
  renderGroups();
  } catch (e) { showError("Couldn't show this rep's data", e); }
  load();
}

// ----- login -----
$("l-go").onclick = async () => {
  $("l-err").textContent = "Signing in…";
  const r = await D.login({ apiBase: $("l-url").value.trim(), username: $("l-user").value.trim(), password: $("l-pass").value,
    mfa_code: $("l-mfa").value.trim() || undefined, organization_id: $("l-org").value || undefined });
  $("l-pass").value = r.ok ? "" : $("l-pass").value;
  if (r.ok) { $("l-err").textContent = ""; const reason = $("l-reason"); if (reason) { reason.hidden = true; reason.textContent = ""; } return route(); }
  if (/MFA/i.test(r.error)) $("l-mfa-row").hidden = false;
  if (r.organizations) { $("l-org-row").hidden = false; $("l-org").innerHTML = r.organizations.map(o => `<option value="${o.id}">${esc(o.name)}</option>`).join(""); }
  $("l-err").textContent = r.status === 429 ? "Too many attempts - try again in 15 minutes." : r.error;
};
$("c-go").onclick = $("acc-reconnect").onclick = async () => {
  $("c-msg").textContent = "Waiting for you to finish logging in to Facebook in the Chrome window…";
  try { const r = await D.connectFacebook(); $("c-msg").textContent = "Connected as " + r.account.label; route(); }
  catch (e) { $("c-msg").textContent = "⚠ " + e.message; }
};
$("c-logout").onclick = async () => { await D.logout(false); route(); };
$("acc-logout").onclick = async () => {
  const wipe = $("acc-wipe").checked;
  if (wipe && !confirm("This signs you out and deletes this PC's Facebook profile for the app. Continue?")) return;
  await D.logout(wipe); route().catch(e => showError("Startup failed", e));};
$("acc-poll").onclick = () => D.pollLeads();
$("g-import").onclick = async () => {
  $("g-import-msg").textContent = "Reading your groups…";
  const r = await D.importGroups().catch(e => ({ error: String(e.message || e) }));
  $("g-import-msg").textContent = r.error ? "⚠ " + r.error : `Added ${r.added} new group(s) · ${r.total} in your dealership's list`;
  if (!r.error) { groups = await D.groups(); if (typeof renderGroups === "function") renderGroups(); }
};
$("app-logs").onclick = () => D.openLogs();
$("app-autostart").onchange = e => D.startWithWindows(e.target.checked);
D.appInfo().catch(() => ({})).then(i => {
  $("app-autostart").checked = i.startWithWindows;
  $("app-info").textContent = `v${i.version} · Chrome: ${i.chrome ? "found" : "not found - install Google Chrome"}`;
  if (i.title) { document.title = i.title; const name = $("app-name"); if (name) name.textContent = i.title; }
});

// ----- queue (this rep only) -----
async function load() {
  try {
    const st = await D.state();
    for (const k of ["queue", "processed", "posted", "sold"]) $("c-" + k).textContent = st.counters[k];
    $("rows").innerHTML = st.jobs.slice(0, 300).map(j => `<tr><td>${esc(j.payload.title)}<div class="muted">VIN ${esc(j.payload.vin)} · Vehicle Id ${esc(j.inventory_id)}</div></td>
      <td>${esc(j.payload.vehicle_type)}</td><td>${j.payload.price ? "$" + Number(j.payload.price).toLocaleString() : "—"}</td>
      <td>${auth.mock && ["QUEUED", "FAILED"].includes(j.status) ? `<button data-approve="${esc(j.id)}">Approve</button>` : ""}</td>
      <td>${statusCell(j)}</td>
      <td>${j.marketplace_url ? `<a href="#" data-open="${esc(j.marketplace_url)}">View on Facebook</a>` : j.status === "POSTED" ? '<span class="muted">posted · no link captured</span>' : ""}</td></tr>`).join("");
  } catch (e) {
    const prompt = signInMessage(e);
    if (prompt) return showSignedOut(prompt);
    log("⚠ " + e.message); showError("Couldn't load the queue", e);
  }
}
const STATUS = { QUEUED: ["On hold", "#64748b"], APPROVED: ["Waiting to post", "#2563eb"], POSTING: ["Posting now…", "#d97706"],
  POSTED: ["✅ Posted", "#15803d"], FAILED: ["⛔ Failed", "#b91c1c"], SOLD_REMOVE: ["Sold - removing", "#7c3aed"], REMOVED: ["Removed", "#64748b"] };
function statusCell(j) {
  const [txt, col] = STATUS[j.status] || [j.status, "#0f172a"];
  const when = j.status === "POSTED" && j.posted_at ? `<div class="muted">${esc(new Date(j.posted_at).toLocaleString())}</div>` : "";
  return `<b style="color:${col}">${esc(txt)}</b>${when}${j.error && j.status !== "POSTED" ? `<div class="muted">${esc(j.error)}</div>` : ""}`;
}
function log(m) { $("log").textContent += m + "\n"; $("log").scrollTop = 1e9; }
function renderGroups() {
  const f = $("g-filter").value.toLowerCase(), sugg = $("g-sugg").checked, set = new Set(chosen.map(g => g.url));
  $("g-list").innerHTML = groups.filter(g => (!sugg || g.suggested || set.has(g.url)) && g.name.toLowerCase().includes(f))
    .map(g => `<label><input type="checkbox" data-url="${esc(g.url)}" data-name="${esc(g.name)}" ${set.has(g.url) ? "checked" : ""}> ${g.suggested ? "★" : ""}${g.posting_confirmed ? "✔" : ""} ${esc(g.name)} <span class="muted">(${g.joined_as})</span></label>`).join("");
}
$("g-list").onchange = e => { const { url, name } = e.target.dataset; chosen = chosen.filter(g => g.url !== url); if (e.target.checked) chosen.push({ name, url }); };
$("g-filter").oninput = renderGroups; $("g-sugg").onchange = renderGroups;
for (const b of document.querySelectorAll(".save")) b.onclick = async () => {
  const p = {}; for (const el of document.querySelectorAll("[id^=s-]")) { const k = el.id.slice(2); p[k] = el.type === "checkbox" ? el.checked : el.type === "number" ? Number(el.value) : el.value; }
  const r = document.querySelector("input[name=renew]:checked"); if (r) p.renewMethod = r.value; p.groups = chosen;
  await D.saveCfg(p); cfg = await D.getCfg(); log("Settings saved");
};
$("rows").onclick = async e => { if (e.target.dataset.open) { e.preventDefault(); return D.openUrl(e.target.dataset.open); } if (e.target.dataset.approve) { await D.approve(e.target.dataset.approve); load(); } };
$("reload").onclick = load;
$("run").onclick = async () => {
  $("run").disabled = true; log("▶ running next job…");
  try { const r = await D.runNow(); if (r && r.error) log("⚠ " + r.error); } catch (e) { log("⚠ " + e.message.split("\n")[0]); }
  finally { $("run").disabled = false; load(); }
};
$("auto").onchange = e => D.auto(e.target.checked);
$("resume").onclick = async () => { await D.resume(); $("resume").hidden = true; };
$("await-done").onclick = async () => {
  const u = $("await-url").value.trim();
  if (u && !/^https:\/\/www\.facebook\.com\/marketplace\/item\/\d+/.test(u)) return alert("Paste a facebook.com/marketplace/item/… link");
  const outcome = { RENEW: "RENEWED", REPOST: "REPOSTED", DELIST: "DELISTED" }[awaiting.action] || "POSTED";
  await D.report(awaiting.job.id, { outcome, marketplace_url: u }); $("await").hidden = true; awaiting = null; load();
};
$("await-cancel").onclick = async () => { await D.report(awaiting.job.id, { outcome: "CANCELLED" }); $("await").hidden = true; awaiting = null; load(); };
D.onLog(log);
D.onAuth(() => route());
D.onLeads(r => log(`Leads: ${(r.results || []).map(x => x.created ? "new lead #" + x.lead_id : `+${x.messages_added ?? 0} msg`).join(", ")}`));
D.onEvent((ev, a) => {
  if (ev === "plan") $("plan").textContent = "Today's slots: " + (a[0].join(", ") || "none");
  if (ev === "paused") { $("resume").hidden = false; log("⛔ paused: " + a[0]); }
  if (ev === "awaiting") { awaiting = { job: a[0], action: a[1] }; $("await").hidden = false;
    log(`⏸ ${a[0]?.payload?.title || "job"}: ${a[2] || "waiting for you to finish in the browser"}`); for (const w of a[3] || []) log("⚠ " + w); }
  if (ev === "claim") log(`claim → ${a[0]}${a[1] ? " (" + a[1] + ")" : ""}`);
  if (ev === "changed") load();
  if (ev === "result") { const r = a[0]; log(r.outcome === "POSTED" ? `✅ POSTED ${r.title}${r.url ? " → " + r.url : " (no link captured)"}` : `⛔ ${r.outcome} ${r.title}: ${r.error}`); }
  if (ev === "error") log("⚠ " + a[0]);
});
route().catch(e => showError("Startup failed", e));
// ---- Phase 2: Craigslist / OfferUp assist (rep clicks Publish) ----
async function loadAssist() {
  const body = document.getElementById("as-rows"); if (!body) return;
  try {
    const { tasks = [] } = await window.dealeros.assistTasks();
    body.innerHTML = "";
    for (const t of tasks) {
      const tr = document.createElement("tr"), price = (t.payload.body.match(/Cash price \$[\d,]+ \| Card price \$[\d,]+/) || [""])[0];
      for (const v of [t.channel, t.payload.title, price, t.status]) { const td = document.createElement("td"); td.textContent = v; tr.appendChild(td); }
      const td = document.createElement("td"), open = document.createElement("button"), skip = document.createElement("button");
      open.textContent = "Open & fill (I click Publish)"; skip.textContent = "Skip";
      open.onclick = async () => { const r = await window.dealeros.assistOpen(t); document.getElementById("as-msg").textContent = r.published ? "Published: " + r.url : "Not published yet"; loadAssist(); };
      skip.onclick = async () => { await window.dealeros.assistSkip(t.id); loadAssist(); };
      td.append(open, " ", skip); tr.appendChild(td); body.appendChild(tr);
    }
  } catch (e) { const prompt = signInMessage(e); if (prompt) return showSignedOut(prompt); document.getElementById("as-msg").textContent = String(e.message || e); }
}
for (const b of document.querySelectorAll(".as-connect")) b.onclick = async () => {
  document.getElementById("as-msg").textContent = "Sign in inside the window that opened…";
  const r = await window.dealeros.assistConnect(b.dataset.ch);
  document.getElementById("as-msg").textContent = r.error || ("Connected: " + r.name);
};
window.dealeros.onDeepLink && window.dealeros.onDeepLink(u => { const b = document.querySelector('header button[data-tab="channels"]'); if (b) b.click(); loadAssist(); });
const asTab = document.querySelector('header button[data-tab="channels"]'); if (asTab) asTab.addEventListener("click", loadAssist);
