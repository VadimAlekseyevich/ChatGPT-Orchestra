const test = require("node:test");
const assert = require("node:assert/strict");

require("../content/selectors.js");
require("../content/utils.js");
require("../content/assistant-turn-tracker.js");
const AssistantMessageReader = require("../content/assistant-message-reader.js");

function turn(id, text, order) {
  const body = { innerText: text, textContent: text };
  const role = { closest() { return root; } };
  const root = {
    order,
    innerText: text,
    textContent: text,
    getAttribute(name) {
      if (name === "data-testid") return `conversation-turn-${id}`;
      if (name === "data-turn") return "assistant";
      return "";
    },
    matches(selector) { return selector === '[data-turn="assistant"]'; },
    closest() { return this; },
    querySelectorAll(selector) {
      if (selector === '[data-turn="assistant"]') return [this];
      if (selector === '[data-message-author-role="assistant"]') return [role];
      if (selector === ".markdown" || selector === '[class*="markdown"]') return [body];
      return [];
    },
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    },
    compareDocumentPosition(other) {
      if (other === this) return 0;
      return order < other.order ? 4 : 2;
    }
  };
  role.closest = () => root;
  return { root, role, body };
}

function documentHarness(items) {
  let turns = [...items];
  return {
    setTurns(next) { turns = [...next]; },
    querySelectorAll(selector) {
      if (selector.includes(",")) return turns.map((item) => item.root);
      if (selector === '[data-message-author-role="assistant"]') return turns.map((item) => item.role);
      if (selector === '[data-turn="assistant"]') return turns.map((item) => item.root);
      if (selector.startsWith('[data-testid^="conversation-turn-"]')) return turns.map((item) => item.root);
      if (selector.startsWith("article")) return turns.map((item) => item.root);
      return [];
    }
  };
}

test("reader separates stable turn identity from identical text identity", () => {
  const firstTurn = turn("1", "DONE", 1);
  const secondTurn = turn("2", "DONE", 2);
  const documentRef = documentHarness([firstTurn]);
  const reader = new AssistantMessageReader({ documentRef, locationRef: { pathname: "/c/example" } });

  const first = reader.getSnapshot();
  documentRef.setTurns([firstTurn, secondTurn]);
  const second = reader.getSnapshot();

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.text, second.text);
  assert.equal(first.textFingerprint, second.textFingerprint);
  assert.notEqual(first.turnId, second.turnId);
  assert.notEqual(first.fingerprint, second.fingerprint);
  assert.equal(second.messageCount, 2);
});

test("reader normalizes zero-width characters and CRLF in assistant text", () => {
  const item = turn("1", "Hello\u200B\r\nDONE\r\n", 1);
  const reader = new AssistantMessageReader({
    documentRef: documentHarness([item]),
    locationRef: { pathname: "/c/example" }
  });

  assert.equal(reader.getLastAssistantText(), "Hello\nDONE");
  assert.equal(reader.getSnapshot().text, "Hello\nDONE");
});

test("reader resolves mixed assistant selector variants by DOM order, not discovery order", () => {
  const oldTurn = turn("old", "old PLAN_V1 response", 1);
  const newTurn = turn("new", "new CRITIQUE response", 2);
  const documentRef = documentHarness([oldTurn, newTurn]);
  documentRef.querySelectorAll = (selector) => {
    if (selector.includes(",")) return [oldTurn.root, newTurn.root];
    if (selector === '[data-message-author-role="assistant"]') return [newTurn.role];
    if (selector === '[data-testid^="conversation-turn-"][data-turn="assistant"]') return [oldTurn.root, newTurn.root];
    if (selector === '[data-turn="assistant"]') return [oldTurn.root, newTurn.root];
    if (selector.startsWith('[data-testid^="conversation-turn-"]')) return [oldTurn.root, newTurn.root];
    if (selector.startsWith("article")) return [oldTurn.root, newTurn.root];
    return [];
  };
  const reader = new AssistantMessageReader({
    documentRef,
    locationRef: { pathname: "/c/example" }
  });

  const snapshot = reader.getSnapshot();
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.text, "new CRITIQUE response");
  assert.equal(snapshot.messageCount, 2);
  assert.ok(snapshot.turnId);
});

test("reader propagates fail-closed tracker ambiguity", () => {
  const tracker = {
    getSnapshot() {
      return {
        ok: false,
        reason: "assistant_turn_identity_ambiguous",
        conversationKey: "/c/example",
        mountedTurnCount: 1,
        assistantTurnCountObserved: 2
      };
    },
    resolveCanonicalElement(value) { return value; },
    getCanonicalTurnElements() { return []; },
    extractText() { return ""; }
  };
  const reader = new AssistantMessageReader({ tracker, locationRef: { pathname: "/c/example" } });
  const snapshot = reader.getSnapshot();
  assert.equal(snapshot.ok, false);
  assert.equal(snapshot.reason, "assistant_turn_identity_ambiguous");
  assert.equal(snapshot.observedTurnCount, 2);
});
