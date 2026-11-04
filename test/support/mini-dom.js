// Small DOM for inbox-parse fixtures. Supports the selectors that parser uses.
function splitSelectors(selector) {
  const parts = [];
  let cur = "", q = "";
  for (const ch of String(selector || "")) {
    if (q) { cur += ch; if (ch === q) q = ""; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === ",") { if (cur.trim()) parts.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

function parseCompound(part) {
  let i = 0;
  let tag = "";
  if (part[0] !== "[") {
    const m = /^[a-zA-Z0-9-]+/.exec(part);
    if (!m) return { tag: "", attrs: [] };
    tag = m[0].toLowerCase();
    i = m[0].length;
  }
  const attrs = [];
  while (i < part.length && part[i] === "[") {
    const end = part.indexOf("]", i);
    if (end < 0) break;
    const body = part.slice(i + 1, end).trim();
    const am = body.match(/^([^\*\~\|\^\$=\s]+)(?:(\*=|=)"([^"]*)")?(?:\s+([iI]))?$/) ||
      body.match(/^([^\*\~\|\^\$=\s]+)(?:(\*=|=)'([^']*)')?(?:\s+([iI]))?$/);
    if (am) attrs.push({ name: am[1].toLowerCase(), op: am[2] || "", value: am[3] || "", flag: (am[4] || "").toLowerCase() });
    else attrs.push({ name: body.toLowerCase(), op: "", value: "", flag: "" });
    i = end + 1;
  }
  return { tag, attrs };
}

function matchesCompound(el, part) {
  if (!el || el.nodeType !== "element") return false;
  const spec = parseCompound(part);
  if (spec.tag && el.tag !== spec.tag) return false;
  for (const a of spec.attrs) {
    const have = el.attrs[a.name];
    if (have == null) return false;
    if (!a.op) continue;
    const left = a.flag === "i" ? String(have).toLowerCase() : String(have);
    const right = a.flag === "i" ? a.value.toLowerCase() : a.value;
    if (a.op === "=" && left !== right) return false;
    if (a.op === "*=" && left.indexOf(right) === -1) return false;
  }
  return true;
}

class Node {
  constructor(tag, attrs) {
    this.nodeType = tag === "#document" ? "document" : "element";
    this.tag = tag;
    this.attrs = attrs || {};
    this.parent = null;
    this.children = [];
  }
  get parentElement() {
    return this.parent && this.parent.nodeType === "element" ? this.parent : null;
  }
  getAttribute(name) {
    const key = String(name || "").toLowerCase();
    return Object.prototype.hasOwnProperty.call(this.attrs, key) ? this.attrs[key] : null;
  }
  get innerText() {
    const parts = [];
    const walk = n => {
      if (n.nodeType === "text") parts.push(n.data);
      else for (const c of n.children) walk(c);
    };
    walk(this);
    return parts.join(" ").replace(/\s+/g, " ").trim();
  }
  matches(selector) {
    return splitSelectors(selector).some(group => {
      const parts = group.split(/\s+/).filter(Boolean);
      if (parts.length !== 1) return false;
      return matchesCompound(this, parts[0]);
    });
  }
  closest(selector) {
    let n = this;
    while (n && n.nodeType === "element") {
      if (n.matches(selector)) return n;
      n = n.parentElement;
    }
    return null;
  }
  querySelectorAll(selector) {
    const groups = splitSelectors(selector);
    const out = [];
    const seen = new Set();
    const start = descendants(this);
    for (const group of groups) {
      const parts = group.split(/\s+/).filter(Boolean);
      if (!parts.length) continue;
      let current = start.filter(el => matchesCompound(el, parts[0]));
      for (let i = 1; i < parts.length; i++) {
        const next = [];
        for (const el of current) {
          for (const d of descendants(el)) if (matchesCompound(d, parts[i])) next.push(d);
        }
        current = next;
      }
      for (const el of current) if (!seen.has(el)) { seen.add(el); out.push(el); }
    }
    return out;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function descendants(root) {
  const out = [];
  const walk = n => { for (const c of n.children || []) { if (c.nodeType === "element") { out.push(c); walk(c); } } };
  walk(root);
  return out;
}

function parseAttrs(raw) {
  const attrs = {};
  const re = /([^\s=\/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m;
  while ((m = re.exec(raw || ""))) {
    attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
  }
  return attrs;
}

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);

function parseHTML(html) {
  const root = new Node("#document");
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<\/([a-zA-Z0-9]+)>|<([a-zA-Z0-9]+)([^>]*?)(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[5] != null) {
      const data = m[5].replace(/\s+/g, " ");
      if (!data.trim()) continue;
      const text = { nodeType: "text", data: m[5], parent: stack[stack.length - 1], children: [] };
      stack[stack.length - 1].children.push(text);
      continue;
    }
    if (m[1]) {
      const name = m[1].toLowerCase();
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag === name) { stack.length = i; break; }
      }
      continue;
    }
    if (m[2]) {
      const el = new Node(m[2].toLowerCase(), parseAttrs(m[3] || ""));
      el.parent = stack[stack.length - 1];
      stack[stack.length - 1].children.push(el);
      if (!m[4] && !VOID.has(el.tag)) stack.push(el);
    }
  }
  return root;
}

module.exports = { parseHTML };
