// Mac (unsigned) builds cannot self-update with electron-updater, so they ask the same GitHub "latest release"
// that DealerOS shows on its Get the app page and tell the rep when a newer version is out.
const RELEASES_API = "https://api.github.com/repos/souzatrailers-ui/dealeros-marketplace-desktop/releases/latest";

function parse(v) { return String(v || "").replace(/^(marketplace-)?v/, "").split(/[.-]/).slice(0, 3).map(n => parseInt(n, 10) || 0); }
function isNewer(latest, current) {
  const a = parse(latest), b = parse(current);
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
async function checkLatest(current, fetchImpl = globalThis.fetch) {
  const r = await fetchImpl(RELEASES_API, { headers: { Accept: "application/vnd.github+json", "User-Agent": "DealerOS-Marketplace" } });
  if (!r.ok) throw new Error(`release check ${r.status}`);
  const rel = await r.json();
  const version = String(rel.tag_name || "").replace(/^(marketplace-)?v/, "");
  return { version, url: rel.html_url || "https://app.dealerosai.ai", newer: isNewer(version, current) };
}
module.exports = { isNewer, checkLatest, RELEASES_API };
