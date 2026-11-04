// 1.0.12: Facebook in English (UK) labels the colour fields "Exterior colour"/"Interior colour" and lists "Grey".
const test = require("node:test"), assert = require("node:assert"), fs = require("fs"), os = require("os"), path = require("path");
const { chromium } = require("playwright-core");
const { Poster } = require("../src/poster");
const FC = require("../src/formcheck");
const FC_SRC = fs.readFileSync(path.join(__dirname, "../src/formcheck.js"), "utf8").replace('typeof module !== "undefined" && module.exports', "false");
const CHROME = ["/usr/bin/google-chrome", "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find(p => fs.existsSync(p));

test("tolerant label regexes", () => {
  for (const t of ["Exterior colour", "exterior color", " Exterior  Colour * ", "Exterior colour (optional)"]) assert.ok(FC.labelRegex("Exterior color").test(t), t);
  assert.ok(!FC.labelRegex("Exterior color").test("Interior colour"));
  assert.ok(FC.labelPrefixRegex("Interior color").test("Interior colour Black"));
  assert.ok(!FC.labelPrefixRegex("Make").test("Makeup"));
  assert.equal(FC.stripLabel("Exterior colour Grey", "Exterior color"), "Grey");
  assert.deepEqual(FC.optionAlternates("Gray"), ["Gray", "Grey"]);
  assert.deepEqual(FC.missingFields({ photos: 3, fields: { "Vehicle type": "Trailer", Location: "x", Year: "2024", Make: "Lark", Model: "7x16", "Exterior color": "Exterior colour", "Interior color": "Grey", Price: "1", Description: "d" } }), ["Exterior color"]);
});

const combo = (lab, id, opts) => `<div role="combobox" aria-label="${lab}" tabindex="0" onclick="document.getElementById('${id}').hidden=false"><span>${lab}</span> <span id="${id}-val"></span></div>
<div id="${id}" role="listbox" aria-label="${lab}" hidden><div>${lab}</div>${opts.map(o => `<div role="option" onclick="document.getElementById('${id}-val').textContent='${o}';document.getElementById('${id}').hidden=true">${o}</div>`).join("")}</div>`;
const UK = `<!doctype html><html><body>
${combo("Vehicle type", "vt", ["Car/van", "Trailer"])}${combo("Year", "yr", ["2024", "2025"])}
<label><span>Make</span><input></label><label><span>Model</span><input></label><label><span>Mileage</span><input></label>
${combo("Exterior colour", "ec", ["Black", "Grey", "Silver"])}${combo("Interior colour", "ic", ["Black", "Grey"])}
<label><span>Price</span><input></label><label><span>Description</span><textarea></textarea></label>
</body></html>`;

test("UK-English form: colour dropdowns found, Grey picked, snapshot sees values", { skip: !CHROME, timeout: 90000 }, async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const pg = await browser.newPage(); await pg.setContent(UK);
  const logs = [], poster = new Poster({ profilesDir: os.tmpdir(), accountId: "t", log: m => logs.push(m) });
  try {
    assert.ok(await poster.choose(pg, "Vehicle type", "Trailer"), logs.join("\n"));
    assert.ok(await poster.choose(pg, "Year", "2024"), logs.join("\n"));
    await poster.fill(pg, "Make", "Lark"); await poster.fill(pg, "Model", "7x16TA"); await poster.fill(pg, "Mileage", 0);
    assert.ok(await poster.choose(pg, "Exterior color", "Gray"), logs.join("\n"));
    assert.ok(await poster.choose(pg, "Interior color", "Black"), logs.join("\n"));
    await poster.fill(pg, "Price", 5999); await poster.fill(pg, "Description", "Nice trailer");
    assert.ok(!logs.some(l => /not found/.test(l)), logs.join("\n"));
    assert.ok(logs.includes("✓ Exterior color: Grey"), logs.join("\n"));
    const snap = await pg.evaluate(`(() => { ${FC_SRC}; return self.DealerOSFormCheck.snapshot(document); })()`);
    assert.equal(snap.fields["Exterior color"], "Grey"); assert.equal(snap.fields["Interior color"], "Black");
    snap.photos = 3; snap.fields.Location = "Orlando";
    assert.deepEqual(FC.missingFields(snap), [], JSON.stringify(snap));
  } finally { await browser.close(); }
});
