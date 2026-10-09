const D = window.dealeros, $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
let cfg, groups = [], chosen = [], awaiting = null, auth = null;

function screen(name) { for (const s of ["login", "connect", "app"]) $(s).hidden = s !== name; }
async function route() {
  auth = await D.auth(); cfg = await D.getCfg();
  if (auth.mock) return showApp();
  if (!auth.session) { $("l-url").value = auth.apiBase || "https://app.dealerosai.ai"; return screen("login"); }
  if (!auth.session.facebook_accounts.length) return screen("connect");
  showApp();
}
async function showApp() {
  screen("app"); groups = await D.groups(); chosen = cfg.groups || [];
  const s = auth.session, fb = s?.facebook_accounts?.[0];
  $("who").textContent = auth.mock ? "MOCK MODE" : `${s.user.full_name || s.user.username} · FB: ${fb ? fb.label : "-"}`;
  $("acc-user").textContent = s ? (s.user.full_name || s.user.username) + " (" + (s.user.email || "") + ")" : "mock";
  $("acc-org").textContent = s ? "dealership #" + s.organization_id : ""; $("acc-fb").textContent = fb ? `${fb.label} (${fb.fb_user_id || "id n/a"})` : "not connected";
  for (const el of document.querySelectorAll("[id^=s-]")) { const k = el.id.slice(2); if (el.type === "checkbox") el.checked = !!cfg[k]; else el.value = cfg[k] ?? ""; }
  for (const r of document.querySelectorAll("input[name=renew]")) r.checked = r.value === cfg.renewMethod;
  renderGroups(); load();
}

// ----- login -----
$("l-go").onclick = async () => {
  $("l-err").textContent = "Signing in…";
  const r = await D.login({ apiBase: $("l-url").value.trim(), username: $("l-user").value.trim(), password: $("l-pass").value,
    mfa_code: $("l-mfa").value.trim() || undefined, organization_id: $("l-org").value || undefined });
  $("l-pass").value = r.ok ? "" : $("l-pass").value;
  if (r.ok) { $("l-err").textContent = ""; return route(); }
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
  await D.logout(wipe); route();
};
$("acc-poll").onclick = () => D.pollLeads();
$("app-logs").onclick = () => D.openLogs();
$("app-autostart").onchange = e => D.startWithWindows(e.target.checked);
D.appInfo().then(i => { $("app-autostart").checked = i.startWithWindows; $("app-info").textContent = `v${i.version} · Chrome: ${i.chrome ? "found" : "not found - install Google Chrome"}`; });

// ----- queue (this rep only) -----
async function load() {
  try {
    const st = await D.state();
    for (const k of ["queue", "processed", "posted", "sold"]) $("c-" + k).textContent = st.counters[k];
    $("rows").innerHTML = st.jobs.slice(0, 300).map(j => `<tr><td>${esc(j.payload.title)}<div class="muted">VIN ${esc(j.payload.vin)} · Vehicle Id ${esc(j.inventory_id)}</div></td>
      <td>${esc(j.payload.vehicle_type)}</td><td>${j.payload.price ? "$" + Number(j.payload.price).toLocaleString() : "—"}</td>
      <td>${auth.mock && ["QUEUED", "FAILED"].includes(j.status) ? `<button data-approve="${esc(j.id)}">Approve</button>` : ""}</td>
      <td>${esc(j.status === "QUEUED" ? "On hold" : j.status)}${j.error ? " · " + esc(j.error) : ""}</td>
      <td>${j.marketplace_url ? `<a href="${esc(j.marketplace_url)}">link</a>` : ""}</td></tr>`).join("");
  } catch (e) { log("⚠ " + e.message); }
}
function log(m) { $("log").textContent += m + "\n"; $("log").scrollTop = 1e9; }
function renderGroups() {
  const f = $("g-filter").value.toLowerCase(), sugg = $("g-sugg").checked, set = new Set(chosen.map(g => g.url));
  $("g-list").innerHTML = groups.filter(g => (!sugg || g.suggested || set.has(g.url)) && g.name.toLowerCase().includes(f))
    .map(g => `<label><input type="checkbox" data-url="${esc(g.url)}" data-name="${esc(g.name)}" ${set.has(g.url) ? "checked" : ""}> ${g.suggested ? "★" : ""}${g.posting_confirmed ? "✔" : ""} ${esc(g.name)} <span class="muted">(${g.joined_as})</span></label>`).join("");
}
$("g-list").onchange = e => { const { url, name } = e.target.dataset; chosen = chosen.filter(g => g.url !== url); if (e.target.checked) chosen.push({ name, url }); };
$("g-filter").oninput = renderGroups; $("g-sugg").onchange = renderGroups;
for (const b of document.querySelectorAll("header button[data-tab]")) b.onclick = () => {
  for (const x of document.querySelectorAll("header button[data-tab]")) x.classList.toggle("on", x === b);
  for (const s of ["queue", "fbmp", "groups", "accounts"]) $(s).hidden = s !== b.dataset.tab;
};
for (const b of document.querySelectorAll(".save")) b.onclick = async () => {
  const p = {}; for (const el of document.querySelectorAll("[id^=s-]")) { const k = el.id.slice(2); p[k] = el.type === "checkbox" ? el.checked : el.type === "number" ? Number(el.value) : el.value; }
  const r = document.querySelector("input[name=renew]:checked"); if (r) p.renewMethod = r.value; p.groups = chosen;
  await D.saveCfg(p); cfg = await D.getCfg(); log("Settings saved");
};
$("rows").onclick = async e => { if (e.target.dataset.approve) { await D.approve(e.target.dataset.approve); load(); } };
$("reload").onclick = load;
$("run").onclick = async () => { await D.runNow(); load(); };
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
  if (ev === "awaiting") { awaiting = { job: a[0], action: a[1] }; $("await").hidden = false; }
  if (ev === "claim") log(`claim → ${a[0]}${a[1] ? " (" + a[1] + ")" : ""}`);
  if (ev === "changed") load();
});
route();
