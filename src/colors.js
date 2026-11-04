// 1.0.10: pick Facebook's "Exterior color" from the DealerOS unit (color fields first, then the description).
// Returns one of Facebook's exterior color option names, or null when nothing reliable is found.
const FB = ["Black", "Blue", "Brown", "Gold", "Green", "Gray", "Pink", "Purple", "Red", "Silver", "Orange",
  "White", "Yellow", "Off white", "Tan", "Beige", "Burgundy", "Turquoise"];
// synonym -> Facebook option (longest phrases are matched first)
const SYN = {
  black: "Black", ebony: "Black", onyx: "Black", jet: "Black", "jet black": "Black", "gloss black": "Black", "matte black": "Black", "black powder coat": "Black",
  white: "White", "bright white": "White", "pearl white": "White", "polar white": "White", "arctic white": "White", "alpine white": "White",
  "off white": "Off white", "off-white": "Off white", ivory: "Off white", cream: "Off white",
  silver: "Silver", pewter: "Silver", aluminum: "Silver", aluminium: "Silver", "mill finish": "Silver", platinum: "Silver", chrome: "Silver",
  gray: "Gray", grey: "Gray", charcoal: "Gray", graphite: "Gray", gunmetal: "Gray", "gun metal": "Gray", slate: "Gray", smoke: "Gray", ash: "Gray", titanium: "Gray",
  red: "Red", maroon: "Burgundy", burgundy: "Burgundy", wine: "Burgundy", crimson: "Red", scarlet: "Red", "candy red": "Red", "victory red": "Red", cherry: "Red",
  blue: "Blue", navy: "Blue", "navy blue": "Blue", "royal blue": "Blue", indigo: "Blue", cobalt: "Blue", "sky blue": "Blue", "electric blue": "Blue",
  turquoise: "Turquoise", teal: "Turquoise", aqua: "Turquoise",
  green: "Green", "hunter green": "Green", olive: "Green", "forest green": "Green", lime: "Green",
  yellow: "Yellow", gold: "Gold", champagne: "Gold", bronze: "Brown",
  orange: "Orange", copper: "Orange", brown: "Brown", "chocolate": "Brown", tan: "Tan", khaki: "Tan", sand: "Beige", beige: "Beige", taupe: "Beige",
  purple: "Purple", violet: "Purple", pink: "Pink",
};
const KEYS = Object.keys(SYN).sort((a, b) => b.length - a.length);
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/[ -]/g, "[\\s-]+");
const ANY = new RegExp(`\\b(${KEYS.map(esc).join("|")})\\b`, "gi");
// words after a color that mean it is NOT the body color ("black rims", "white LED lights", "black interior")
const NOT_BODY = /^\s*(?:-|\/)?\s*(?:interior|inside|floor|flooring|walls?|ceiling|rims?|wheels?|tires?|lights?|leds?|led|lighting|trim|fenders?|seats?|tongue|frame|ramp|hardware|accents?|stripes?|decals?|letters|lettering|vinyl|plywood|wood|rubber|mats?|cabinets?|doors? hinges?|hinges|bumper|step|steps|jack|coupler|chains?|straps?)\b/i;
const toFb = w => { const k = String(w).toLowerCase().replace(/[\s-]+/g, " ").trim(); return SYN[k] || SYN[k.replace(" ", "-")] || null; };

function fromText(text) {
  const t = String(text || "").replace(/<[^>]+>/g, " ");
  if (!t.trim()) return null;
  // 1) labelled: "Exterior color: Charcoal", "Color - Pewter", "Colour: dark grey"
  const lab = t.match(/\b(?:exterior\s+)?colou?r\s*(?:[:=\-–]|is)\s*([^\n,;|.]{1,40})/i);
  if (lab) { ANY.lastIndex = 0; const m = ANY.exec(lab[1]); if (m) return toFb(m[1]); }
  // 2) "<color> exterior / finish / paint / skin / body / metallic"
  const near = new RegExp(`\\b(${KEYS.map(esc).join("|")})\\b\\s+(?:metallic\\s+|pearl\\s+|gloss\\s+)?(?:exterior|finish|paint|painted|skin|sides?|body|metallic|powder[\\s-]?coat(?:ed)?)\\b`, "i").exec(t);
  if (near) return toFb(near[1]);
  // 3) first color word that isn't describing a part (rims, lights, interior, floor...)
  ANY.lastIndex = 0; let m;
  while ((m = ANY.exec(t))) { if (!NOT_BODY.test(t.slice(m.index + m[0].length, m.index + m[0].length + 30))) return toFb(m[1]); }
  return null;
}
/** p = job payload. Priority: dealer color fields > description > null (caller keeps its old behavior). */
function exteriorColor(p) {
  p = p || {};
  for (const k of ["color", "colour", "exterior_color_raw", "ext_color", "exteriorColor", "exterior_colour", "paint_color"]) { const c = p[k] && fromText(p[k]); if (c) return { color: c, source: k }; }
  // exterior_color is mapped server-side and defaults to "Black", so a plain "Black" there is not trusted over the description.
  const srv = p.exterior_color && fromText(p.exterior_color);
  if (srv && srv !== "Black") return { color: srv, source: "exterior_color" };
  for (const k of ["description", "title", "notes"]) { const c = fromText(p[k]); if (c) return { color: c, source: k }; }
  if (srv) return { color: srv, source: "exterior_color" };
  return null;
}
module.exports = { exteriorColor, fromText, FB_EXTERIOR_COLORS: FB };
