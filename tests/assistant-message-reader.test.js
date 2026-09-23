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


test("merges mixed assistant selector variants so a newer fallback turn is not hidden by an older primary match", () => {
  const oldTurn = {
    innerText: "old PLAN_V1 response",
    textContent: "old PLAN_V1 response",
    querySelector() { return null; },
    closest() { return this; }
  };
  const oldRoleNode = {
    closest() { return oldTurn; }
  };
  const newTurn = {
    innerText: "new CRITIQUE response",
    textContent: "new CRITIQUE response",
    querySelector() { return null; },
    closest() { return this; }
  };
  const documentRef = {
    querySelectorAll(selector) {
      if (selector === '[data-message-author-role="assistant"]') return [oldRoleNode];
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
