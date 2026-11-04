// Read-only parse of a Facebook Marketplace inbox DOM.
//
// 1.0.17 took every [role=row] on the page. On /marketplace/inbox/ those rows are the
// LEFT chat list (one row per buyer), and [role=main] h1/h2 is not the buyer, so the
// header was empty. The link locator only kept /messages/t/ and /marketplace/t/ hrefs.
// List rows usually point at /marketplace/inbox/?thread_id=<id>, which that locator
// dropped, so one surviving permalink (or one shared /t/<id>) became the only thread
// and every chat-list name was stored on it. The server then labeled that lead
// "Facebook buyer". This parser keeps one thread id per conversation and reads
// bubbles from the open pane only. It never clicks, types, or sends.
function parseInbox(opts) {
  opts = opts || {};
  const document = opts.document || (typeof globalThis !== "undefined" ? globalThis.document : null);
  const emptyOpen = { thread_id: "", buyer_name: "", listing_url: "", messages: [], rejected: false };
  if (!document || !document.querySelectorAll) return opts.mode === "list" ? { conversations: [] } : emptyOpen;

  const CHROME = {
    marketplace: 1, "facebook marketplace": 1, "facebook marketplace assistant": 1,
    chats: 1, chat: 1, inbox: 1, facebook: 1, "marketplace inbox": 1,
    unread: 1, "unread messages": 1, "you sent": 1, "you sent a message": 1,
    "message sent": 1, seen: 1, delivered: 1, enter: 1
  };
  const STOP = {
    a: 1, an: 1, the: 1, is: 1, it: 1, its: 1, this: 1, that: 1, still: 1, available: 1,
    yes: 1, no: 1, hi: 1, hey: 1, hello: 1, thanks: 1, thank: 1, please: 1, you: 1, your: 1,
    my: 1, me: 1, we: 1, our: 1, can: 1, could: 1, would: 1, pick: 1, up: 1, when: 1, where: 1,
    what: 1, how: 1, much: 1, price: 1, trailer: 1, trailers: 1, interested: 1, ok: 1, okay: 1,
    sure: 1, lol: 1, wow: 1, good: 1, morning: 1, afternoon: 1, evening: 1, saturday: 1,
    sunday: 1, monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1, today: 1,
    tomorrow: 1, pickup: 1, cash: 1, deal: 1, and: 1, or: 1, for: 1, to: 1, of: 1, in: 1, on: 1,
    at: 1, with: 1, from: 1, have: 1, has: 1, just: 1, got: 1, need: 1, want: 1, looking: 1,
    info: 1, information: 1, message: 1, sent: 1, seen: 1, delivered: 1, unread: 1, chat: 1,
    chats: 1, inbox: 1, marketplace: 1, facebook: 1, assistant: 1, new: 1, photo: 1, image: 1,
    attachment: 1
  };
  const GENERIC_ID = {
    inbox: 1, marketplace: 1, messages: 1, t: 1, thread: 1, facebook: 1, unknown: 1,
    undefined: 1, null: 1, chats: 1, chat: 1, new: 1
  };

  function norm(s) { return String(s || "").replace(/\s+/g, " ").trim(); }
  function fold(s) { return norm(s).toLowerCase(); }
  function isChrome(text) { return !!CHROME[fold(text)]; }

  function isThreadId(id) {
    const s = norm(id);
    if (!s || GENERIC_ID[s.toLowerCase()]) return false;
    if (/^\d{4,}$/.test(s)) return true;
    if (/^[A-Za-z0-9._-]{8,}$/.test(s) && /\d/.test(s)) return true;
    return false;
  }

  function threadIdFromHref(href) {
    if (!href) return "";
    let u;
    try { u = new URL(String(href), "https://www.facebook.com/marketplace/inbox/"); }
    catch (e) { return ""; }
    const candidates = [u.searchParams.get("thread_id"), u.searchParams.get("tid"), u.searchParams.get("threadid")];
    const sources = [u.pathname, u.hash];
    for (let i = 0; i < sources.length; i++) {
      const m = String(sources[i] || "").match(/\/(?:messages|marketplace)\/t\/([^/?#&]+)/i);
      if (m) {
        try { candidates.push(decodeURIComponent(m[1])); }
        catch (e) { candidates.push(m[1]); }
      }
    }
    for (let i = 0; i < candidates.length; i++) {
      if (isThreadId(candidates[i])) return norm(candidates[i]);
    }
    return "";
  }

  function attr(el, name) { return el && el.getAttribute ? (el.getAttribute(name) || "") : ""; }

  function inChatList(el) {
    let n = el;
    while (n && n.getAttribute) {
      const role = fold(attr(n, "role"));
      const label = fold(attr(n, "aria-label"));
      const testid = attr(n, "data-testid");
      if (role === "navigation") return true;
      if (testid === "mwthreadlist" || testid === "chat-list") return true;
      if (label === "chats" || label === "chat" || label === "marketplace chats" || label === "marketplace inbox") return true;
      if (label === "marketplace" && (role === "grid" || role === "list" || role === "navigation")) return true;
      n = n.parentElement || null;
    }
    return false;
  }

  function nameToken(tok) {
    if (!tok || /[0-9_]/.test(tok)) return false;
    let letters = 0;
    for (const ch of tok) {
      if (/\p{L}/u.test(ch)) letters += 1;
      else if ("'.’-".indexOf(ch) === -1 && ch !== "-") return false;
    }
    return letters >= 2;
  }

  function looksLikeName(text) {
    const raw = norm(text);
    if (!raw || raw.length > 80 || raw.length < 2) return false;
    if (/[?!.:;|/\\@#$%^&*+=<>0-9]/.test(raw) || raw.indexOf(",") !== -1) return false;
    const parts = raw.split(" ");
    if (!parts.length || parts.length > 4) return false;
    for (let i = 0; i < parts.length; i++) if (STOP[fold(parts[i])]) return false;
    return parts.every(nameToken);
  }

  function isSenderList(text) {
    if (String(text || "").indexOf(",") === -1) return false;
    const parts = String(text).split(",").map(norm).filter(Boolean);
    if (parts.length < 2 || parts.length > 6) return false;
    return parts.every(looksLikeName);
  }

  function chatListRoots() {
    const all = [...document.querySelectorAll('[role="navigation"], [role="grid"], [role="list"], [data-testid="mwthreadlist"], [data-testid="chat-list"]')];
    return all.filter(el => {
      const role = fold(attr(el, "role"));
      const label = fold(attr(el, "aria-label"));
      const testid = attr(el, "data-testid");
      if (role === "navigation") return true;
      if (testid === "mwthreadlist" || testid === "chat-list") return true;
      if (label === "chats" || label === "chat" || label === "marketplace chats" || label === "marketplace inbox") return true;
      if (label === "marketplace" && (role === "grid" || role === "list")) return true;
      return false;
    });
  }

  function collect() {
    const out = [];
    const ids = new Set();
    const roots = chatListRoots();
    for (let r = 0; r < roots.length; r++) {
      const root = roots[r];
      let rows = [...root.querySelectorAll('[role="row"]')].filter(row => row.querySelectorAll('[role="row"]').length === 0);
      if (!rows.length) rows = [...root.querySelectorAll("a[href]")];
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const link = (row.matches && row.matches("a[href]")) ? row : (row.querySelector ? row.querySelector("a[href]") : null);
        const href = link ? attr(link, "href") : "";
        const dataId = attr(row, "data-thread-id") || (link ? attr(link, "data-thread-id") : "");
        const threadId = threadIdFromHref(href) || (isThreadId(dataId) ? norm(dataId) : "");
        if (!threadId || ids.has(threadId)) continue;
        ids.add(threadId);
        const bits = [...row.querySelectorAll('[dir="auto"]')].map(n => norm(n.innerText || "")).filter(Boolean);
        out.push({ thread_id: threadId, buyer_name: bits[0] || "", href: href });
      }
    }
    return out;
  }

  function labelBuyer(el) {
    const own = attr(el, "aria-label");
    const m = own.match(/conversation with\s+(.+)/i);
    if (!m) return "";
    const name = norm(m[1]).replace(/[.]+$/, "");
    if (!name || isChrome(name)) return "";
    return name;
  }

  function messagePane() {
    const main = document.querySelector('[role="main"]') || document.querySelector("body") || document;
    const labeled = [...main.querySelectorAll("[aria-label]")].find(el => {
      if (inChatList(el)) return false;
      const a = fold(attr(el, "aria-label"));
      return a.indexOf("messages in conversation") !== -1 || a.indexOf("conversation with") !== -1 || a === "messages" || a.indexOf("message list") !== -1;
    });
    if (labeled) return labeled;
    const grids = [...main.querySelectorAll('[role="grid"], [role="log"], [data-testid="message-list"]')].filter(g => !inChatList(g));
    if (grids.length) return grids[grids.length - 1];
    if (!inChatList(main)) return main;
    return null;
  }

  function buyerFromPane(pane) {
    const main = document.querySelector('[role="main"]') || document.querySelector("body") || document;
    const scopes = [];
    if (pane) scopes.push(pane);
    if (main && scopes.indexOf(main) === -1) scopes.push(main);
    for (let s = 0; s < scopes.length; s++) {
      const scope = scopes[s];
      const own = labelBuyer(scope);
      if (own) return own;
      const nodes = scope.querySelectorAll ? [...scope.querySelectorAll("[aria-label]")] : [];
      for (let i = 0; i < nodes.length; i++) {
        if (inChatList(nodes[i])) continue;
        const found = labelBuyer(nodes[i]);
        if (found) return found;
      }
    }
    const title = main.querySelector && main.querySelector('[data-testid="thread-title"]');
    if (title && !inChatList(title)) {
      const t = norm(title.innerText || "");
      if (t && !isChrome(t)) return t;
    }
    const headings = main.querySelectorAll ? [...main.querySelectorAll("h1, h2")] : [];
    for (let i = 0; i < headings.length; i++) {
      if (inChatList(headings[i])) continue;
      const t = norm(headings[i].innerText || "");
      if (t && !isChrome(t)) return t;
    }
    return "";
  }

  function directionOf(row) {
    if (attr(row, "data-outgoing") === "true") return "OUTBOUND";
    if (/^you sent\b/i.test(attr(row, "aria-label"))) return "OUTBOUND";
    const bits = [...row.querySelectorAll('[dir="auto"], h1, h2, h3, h4, h5, h6')].map(n => norm(n.innerText || ""));
    for (let i = 0; i < bits.length; i++) if (/^you sent$/i.test(bits[i])) return "OUTBOUND";
    return "INBOUND";
  }

  function messageText(row) {
    const bits = [...row.querySelectorAll('[dir="auto"]')].map(n => norm(n.innerText || "")).filter(Boolean);
    const useful = bits.filter(b => !/^you sent$/i.test(b) && !isChrome(b));
    if (useful.length) return useful.join("\n");
    // No bubble text. Do not use the whole row: chat-list rows read as
    // "Name + preview + You sent" and the first line is just the buyer.
    const whole = norm(row.innerText || "");
    if (!whole || isChrome(whole) || isSenderList(whole) || looksLikeName(whole)) return "";
    return whole;
  }

  function messageTime(row) {
    const t = row.querySelector("[data-time], time");
    if (!t) return null;
    return attr(t, "data-time") || attr(t, "datetime") || null;
  }

  function openThreadId(pageUrl) {
    const fromPage = threadIdFromHref(pageUrl);
    if (fromPage) return fromPage;
    const ids = [];
    const links = [...document.querySelectorAll("a[href]")];
    for (let i = 0; i < links.length; i++) {
      if (inChatList(links[i])) continue;
      const id = threadIdFromHref(attr(links[i], "href"));
      if (id) ids.push(id);
    }
    const uniq = [...new Set(ids)];
    // One permalink in the open pane is that conversation. Many ids are the
    // chat list; never pick one of them as a shared thread for every row.
    return uniq.length === 1 ? uniq[0] : "";
  }

  function mostlyNames(texts) {
    if (texts.length < 3) return false;
    let bad = 0;
    for (let i = 0; i < texts.length; i++) {
      const t = texts[i];
      if (isChrome(t) || isSenderList(t) || looksLikeName(t)) bad += 1;
    }
    return bad >= 3 && bad * 5 >= texts.length * 3;
  }

  if (opts.mode === "list") return { conversations: collect() };

  const pane = messagePane();
  const selfName = fold(opts.expectedName || "");
  const sibling = new Set((opts.siblingNames || []).map(fold).filter(n => n && n !== selfName && n !== "facebook buyer"));
  const rows = pane ? [...pane.querySelectorAll('[role="row"], [data-testid="message-row"]')].filter(row => !inChatList(row) && row.querySelectorAll('[role="row"]').length === 0) : [];
  const raw = [];
  for (let i = 0; i < rows.length; i++) {
    const text = messageText(rows[i]);
    if (!text) continue;
    raw.push({ text: text, time: messageTime(rows[i]), direction: directionOf(rows[i]) });
  }
  // Judge the pane before dropping chrome lines, so a list of names plus
  // "Marketplace" is still rejected instead of posted as a conversation.
  const rejected = mostlyNames(raw.map(m => m.text));
  const messages = rejected ? [] : raw.filter(m => !isChrome(m.text) && !isSenderList(m.text) && !sibling.has(fold(m.text)));
  let buyer = buyerFromPane(pane) || norm(opts.expectedName || "");
  if (isChrome(buyer) || fold(buyer) === "facebook buyer") buyer = norm(opts.expectedName || "");
  if (isChrome(buyer) || fold(buyer) === "facebook buyer") buyer = "";
  const main = document.querySelector('[role="main"]') || document.querySelector("body") || document;
  let listing = "";
  const links = main.querySelectorAll ? [...main.querySelectorAll("a[href]")] : [];
  for (let i = 0; i < links.length; i++) {
    if (inChatList(links[i])) continue;
    const rawHref = attr(links[i], "href");
    const abs = links[i].href || "";
    const candidate = abs.indexOf("/marketplace/item/") !== -1 ? abs : rawHref;
    if (candidate.indexOf("/marketplace/item/") !== -1) { listing = candidate; break; }
  }
  const fromPage = openThreadId(opts.pageUrl || "");
  return {
    thread_id: fromPage || (isThreadId(opts.expectedId) ? norm(opts.expectedId) : ""),
    buyer_name: buyer,
    listing_url: listing,
    messages: messages,
    rejected: rejected
  };
}

module.exports = { parseInbox };
