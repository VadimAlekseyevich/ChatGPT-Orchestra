const test = require("node:test");
const assert = require("node:assert/strict");

require("../content/selectors.js");
require("../content/utils.js");
const AssistantMessageReader = require("../content/assistant-message-reader.js");

function message(text) {
  return {
    innerText: text,
    textContent: text,
    querySelector() { return null; }
  };
}

test("fingerprint changes when a new assistant turn has identical text", () => {
  let messages = [message("DONE")];
  const documentRef = {
    querySelectorAll(selector) {
      return selector === '[data-message-author-role="assistant"]' ? messages : [];
    }
  };
  const locationRef = { pathname: "/c/example" };
  const reader = new AssistantMessageReader({ documentRef, locationRef });

  const first = reader.getSnapshot();
  messages = [message("DONE"), message("DONE")];
  const second = reader.getSnapshot();

  assert.equal(first.text, second.text);
  assert.notEqual(first.fingerprint, second.fingerprint);
  assert.equal(second.messageCount, 2);
});

test("normalizes zero-width characters and CRLF in assistant text", () => {
  const messages = [message("Hello\u200B\r\nDONE\r\n")];
  const documentRef = {
    querySelectorAll(selector) {
      return selector === '[data-message-author-role="assistant"]' ? messages : [];
    }
  };
  const reader = new AssistantMessageReader({
    documentRef,
    locationRef: { pathname: "/c/example" }
  });

  assert.equal(reader.getLastAssistantText(), "Hello\nDONE");
});


test("merges mixed assistant selector variants in DOM order instead of selector discovery order", () => {
  let oldTurn;
  let newTurn;
  const position = (self, other) => {
    if (self === other) return 0;
    if (self === oldTurn && other === newTurn) return 4;
    if (self === newTurn && other === oldTurn) return 2;
    return 0;
  };
  oldTurn = {
    innerText: "old PLAN_V1 response",
    textContent: "old PLAN_V1 response",
    querySelector() { return null; },
    closest() { return this; },
    compareDocumentPosition(other) { return position(this, other); }
  };
  newTurn = {
    innerText: "new CRITIQUE response",
    textContent: "new CRITIQUE response",
    querySelector() { return null; },
    closest() { return this; },
    compareDocumentPosition(other) { return position(this, other); }
  };
  const newRoleNode = {
    closest() { return newTurn; }
  };
  const documentRef = {
    querySelectorAll(selector) {
      // Deliberately discover the newest turn first through the primary selector.
      // Without a DOM-order sort the fallback then appends the old turn last and
      // getSnapshot() incorrectly returns the old response.
      if (selector === '[data-message-author-role="assistant"]') return [newRoleNode];
      if (selector === '[data-testid^="conversation-turn-"][data-turn="assistant"]') return [oldTurn, newTurn];
      return [];
    }
  };
  const reader = new AssistantMessageReader({
    documentRef,
    locationRef: { pathname: "/c/example" }
  });

  const snapshot = reader.getSnapshot();
  assert.equal(snapshot.text, "new CRITIQUE response");
  assert.equal(snapshot.messageCount, 2);
  assert.ok(snapshot.fingerprint);
});
