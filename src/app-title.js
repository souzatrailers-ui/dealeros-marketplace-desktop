/** Window title and header label. The version is the one the running app reports. */
function appWindowTitle(version) {
  const v = String(version || "").trim();
  return v ? `DealerOS Marketplace v${v}` : "DealerOS Marketplace";
}

module.exports = { appWindowTitle };
