const test = require("node:test"), assert = require("node:assert");
const fs = require("fs"), path = require("path");
const { parseHTML } = require("./support/mini-dom");
const { parseInbox } = require("../src/inbox-parse");
const { facebookProfileName } = require("../src/poster");

const fixture = name => parseHTML(fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8"));

test("open thread ignores the chat list and reads the buyer from the conversation label", () => {
  const doc = fixture("marketplace-inbox.html");
  // 1.0.17: every role=row on the document, first dir=auto, header h1/h2 inside main.
  const oldRows = [...doc.querySelectorAll('[role="row"]')];
  const oldTexts = oldRows.map(r => (r.querySelector('[dir="auto"]') || r).innerText.trim());
  assert.ok(oldTexts.includes("Malina Laro"));
  assert.ok(oldTexts.includes("Cole Sanford"));
  assert.ok(oldTexts.includes("Facebook Marketplace Assistant"));
  assert.equal(doc.querySelector('[role="main"] h1, [role="main"] h2, [data-testid="thread-title"]'), null);

  const listed = parseInbox({ document: doc, mode: "list" });
  const ids = listed.conversations.map(c => c.thread_id);
  assert.deepEqual(ids, ["100001", "100002", "100003", "100004", "100005", "100006", "100007", "100008", "100009"]);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(listed.conversations.find(c => c.thread_id === "100003").buyer_name, "Malina Laro");
  assert.equal(listed.conversations.find(c => c.thread_id === "100006").buyer_name, "Šƿẫřḱ Ḿotořš");

  const open = parseInbox({
    document: doc, mode: "open",
    pageUrl: "https://www.facebook.com/messages/t/100003",
    siblingNames: listed.conversations.map(c => c.buyer_name),
    expectedId: "100003", expectedName: "Malina Laro",
  });
  assert.equal(open.rejected, false);
  assert.equal(open.thread_id, "100003");
  assert.equal(open.buyer_name, "Malina Laro");
  assert.equal(open.listing_url, "https://www.facebook.com/marketplace/item/555/?ref=inbox");
  assert.deepEqual(open.messages.map(m => m.text), ["Is the 7x14 still available?", "Yes, it is on the lot."]);
  assert.deepEqual(open.messages.map(m => m.direction), ["INBOUND", "OUTBOUND"]);
  assert.deepEqual(open.messages.map(m => m.time), ["2026-11-02T11:50:00Z", "2026-11-02T11:52:00Z"]);
  for (const name of ["Cole Sanford", "Marketplace", "Cole, Malina", "Facebook Marketplace Assistant", "Malina Margaret"]) {
    assert.equal(open.messages.some(m => m.text === name), false, name);
  }
});

test("rows that share one inbox URL are not stored on the single permalink", () => {
  const doc = fixture("marketplace-inbox-collapsed.html");
  const oldTexts = [...doc.querySelectorAll('[role="row"]')].map(r => (r.querySelector('[dir="auto"]') || r).innerText.trim());
  assert.ok(oldTexts.includes("Cole Sanford") && oldTexts.includes("Marketplace"));
  const listed = parseInbox({ document: doc, mode: "list" });
  assert.deepEqual(listed.conversations.map(c => c.thread_id), ["5550123"]);
  assert.equal(listed.conversations[0].buyer_name, "Malina Margaret");
  const open = parseInbox({
    document: doc, mode: "open",
    pageUrl: "https://www.facebook.com/marketplace/inbox/",
    siblingNames: oldTexts,
  });
  assert.deepEqual(open.messages, []);
  assert.equal(open.thread_id, "");
  assert.equal(open.rejected, false);
});

test("mock inbox still yields Maria's own messages and thread", () => {
  const doc = parseHTML(fs.readFileSync(path.join(__dirname, "../mock/fake-inbox.html"), "utf8"));
  const open = parseInbox({ document: doc, mode: "open", pageUrl: "file:///mock/fake-inbox.html" });
  assert.equal(open.buyer_name, "Maria Lopez");
  assert.equal(open.thread_id, "9001");
  assert.deepEqual(open.messages.map(m => [m.text, m.direction, m.time]), [
    ["Is this still available?", "INBOUND", "2026-10-09T10:01:00"],
    ["Yes it is!", "OUTBOUND", "2026-10-09T10:03:00"],
  ]);
  assert.ok(open.listing_url.includes("/marketplace/item/555"));
});

test("a pane full of chat-list names is rejected", () => {
  const html = `<div role="main"><div role="grid" aria-label="Messages in conversation with Facebook buyer">
    <div role="row"><div dir="auto">Malina Laro</div></div>
    <div role="row"><div dir="auto">Cole Sanford</div></div>
    <div role="row"><div dir="auto">Marketplace</div></div>
    <div role="row"><div dir="auto">Cole, Malina</div></div>
  </div></div>`;
  const open = parseInbox({ document: parseHTML(html), mode: "open", pageUrl: "https://www.facebook.com/messages/t/100003" });
  assert.equal(open.rejected, true);
  assert.deepEqual(open.messages, []);
});

test("notification-count tab title is not a Facebook profile name", () => {
  assert.equal(facebookProfileName("", "(12) Facebook"), "");
  assert.equal(facebookProfileName("", "(12) Facebook | Facebook"), "");
  assert.equal(facebookProfileName("Sam De", "(12) Facebook"), "Sam De");
  assert.equal(facebookProfileName("", "Sam De | Facebook"), "Sam De");
});
