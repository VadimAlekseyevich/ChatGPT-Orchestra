const test = require("node:test");
const assert = require("node:assert/strict");

const AssistantTurnTracker = require("../content/assistant-turn-tracker.js");

const DEFAULT_SELECTORS = {
  turnRoots: [
    '[data-testid^="conversation-turn-"]',
    'article[data-turn]',
    'section[data-turn]',
    'article[data-message-author-role]'
  ],
  assistantRoleMarkers: [
    '[data-message-author-role="assistant"]',
    '[data-role="assistant"]',
    '[data-message-author="assistant"]',
    '[data-turn="assistant"]'
  ],
  assistantMessages: [
    '[data-message-author-role="assistant"]',
    '[data-testid^="conversation-turn-"]:has([data-message-author-role="assistant"])',
    'article[data-turn="assistant"]'
  ],
  assistantBodies: [".markdown", ".prose", '[class*="markdown"]', "[data-message-content]"]
};

function permutations(values) {
  if (values.length <= 1) return [values];
  const result = [];
  values.forEach((value, index) => {
    const rest = values.slice(0, index).concat(values.slice(index + 1));
    for (const suffix of permutations(rest)) result.push([value, ...suffix]);
  });
  return result;
}

function createTurn({
  key,
  text = "",
  order = 0,
  stable = true,
  role = "assistant",
  tag = "article",
  disconnected = false,
  nestedBodies = false
} = {}) {
  const attrs = {
    "data-testid": stable ? `conversation-turn-${key}` : "",
    "data-turn": role
  };
  const body = {
    kind: "body",
    innerText: text,
    textContent: text,
    closest() { return root; },
    compareDocumentPosition(other) { return root.compareDocumentPosition(other?.root || other); }
  };
  const code = {
    kind: "code",
    innerText: "const x = 1;",
    textContent: "const x = 1;",
    closest() { return root; }
  };
  const roleMarker = {
    kind: "role",
    root: null,
    closest() { return root; },
    getAttribute(name) { return name === "data-message-author-role" ? role : ""; },
    matches(selector) { return selector === '[data-message-author-role="assistant"]' && role === "assistant"; }
  };
  const root = {
    key,
    order,
    tag,
    disconnected,
    body,
    roleMarker,
    innerText: text,
    textContent: text,
    getAttribute(name) { return attrs[name] || ""; },
    closest() { return this; },
    matches(selector) {
      if (selector === '[data-turn="assistant"]') return role === "assistant";
      if (selector === '[data-message-author-role="assistant"]') return false;
      if (selector.includes('[data-testid^="conversation-turn-"]')) return stable;
      if (selector.startsWith("article")) return tag === "article";
      if (selector.startsWith("section")) return tag === "section";
      return false;
    },
    querySelectorAll(selector) {
      if (selector === '[data-message-author-role="assistant"]') return role === "assistant" ? [roleMarker] : [];
      if (selector === '[data-role="assistant"]' || selector === '[data-message-author="assistant"]') return [];
      if (selector === '[data-turn="assistant"]') return role === "assistant" ? [this] : [];
      if (selector === ".markdown" || selector === '[class*="markdown"]') return nestedBodies ? [body, code] : [body];
      if (selector === ".prose" || selector === "[data-message-content]") return [];
      return [];
    },
    compareDocumentPosition(other) {
      const target = other?.root || other;
      if (!target || target === this) return 0;
      if (disconnected || target.disconnected) return 1;
      return order < target.order ? 4 : 2;
    }
  };
  roleMarker.root = root;
  body.root = root;
  return root;
}

function setText(turn, text) {
  turn.innerText = text;
  turn.textContent = text;
  turn.body.innerText = text;
  turn.body.textContent = text;
}

function createDocument(turns = []) {
  let mounted = [...turns];
  let exposeRootOrder = true;
  let selectorOverrides = new Map();
  return {
    setTurns(next) { mounted = [...next]; },
    setExposeRootOrder(value) { exposeRootOrder = Boolean(value); },
    setSelectorOverride(selector, value) { selectorOverrides.set(selector, value); },
    querySelectorAll(selector) {
      if (selectorOverrides.has(selector)) return selectorOverrides.get(selector);
      if (selector.includes(",")) return exposeRootOrder ? [...mounted] : [];
      if (selector === '[data-message-author-role="assistant"]') return mounted.filter((item) => item.getAttribute("data-turn") === "assistant").map((item) => item.roleMarker);
      if (selector === '[data-role="assistant"]' || selector === '[data-message-author="assistant"]') return [];
      if (selector === '[data-turn="assistant"]') return mounted.filter((item) => item.getAttribute("data-turn") === "assistant");
      if (selector.startsWith('[data-testid^="conversation-turn-"]')) return mounted.filter((item) => item.getAttribute("data-testid"));
      if (selector.startsWith("article")) return mounted.filter((item) => item.tag === "article" && item.getAttribute("data-turn") === "assistant");
      if (selector.startsWith("section")) return mounted.filter((item) => item.tag === "section" && item.getAttribute("data-turn") === "assistant");
      return [];
    }
  };
}

function trackerHarness(turns, { pathname = "/c/example", selectors = DEFAULT_SELECTORS, maxHistory = 64 } = {}) {
  const documentRef = createDocument(turns);
  const locationRef = { pathname };
  const tracker = new AssistantTurnTracker({ documentRef, locationRef, selectors, maxHistory });
  return { tracker, documentRef, locationRef };
}

test("selector permutations do not change canonical ordering, identities or latest text", () => {
  const oldTurn = createTurn({ key: "10", text: "old", order: 1 });
  const newTurn = createTurn({ key: "11", text: "new", order: 2 });
  const selectors = DEFAULT_SELECTORS.assistantMessages;
  let expected = null;

  for (const order of permutations(selectors)) {
    const { tracker, documentRef } = trackerHarness([oldTurn, newTurn], {
      selectors: { ...DEFAULT_SELECTORS, assistantMessages: order }
    });
    documentRef.setSelectorOverride(order[0], [newTurn.roleMarker]);
    documentRef.setSelectorOverride(order.at(-1), [oldTurn, newTurn]);
    const snapshot = tracker.getSnapshot();
    assert.equal(snapshot.ok, true);
    const comparable = {
      count: snapshot.mountedTurnCount,
      ids: snapshot.turns.map((item) => item.turnId),
      sources: snapshot.turns.map((item) => item.identitySource),
      latestTurnId: snapshot.latestTurnId,
      latestText: snapshot.latestText
    };
    expected ||= comparable;
    assert.deepEqual(comparable, expected);
  }
});

test("multiple selector matches and nested role markers collapse to one canonical assistant turn", () => {
  const turn = createTurn({ key: "1", text: "DONE", order: 1 });
  const { tracker, documentRef } = trackerHarness([turn]);
  documentRef.setSelectorOverride('[data-message-author-role="assistant"]', [turn.roleMarker, turn.roleMarker]);
  documentRef.setSelectorOverride('article[data-turn="assistant"]', [turn]);
  const snapshot = tracker.getSnapshot();
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.turns.length, 1);
  assert.equal(snapshot.latestText, "DONE");
});

test("same assistant turn keeps turnId while streaming text fingerprint changes", () => {
  const turn = createTurn({ key: "stream", text: "PL", order: 1, stable: false });
  const { tracker } = trackerHarness([turn]);
  const first = tracker.getSnapshot();
  setText(turn, "PLAN");
  const second = tracker.getSnapshot();
  setText(turn, "PLAN_V1");
  const third = tracker.getSnapshot();

  assert.equal(first.latestTurnId, second.latestTurnId);
  assert.equal(second.latestTurnId, third.latestTurnId);
  assert.notEqual(first.latestTextFingerprint, second.latestTextFingerprint);
  assert.notEqual(second.latestTextFingerprint, third.latestTextFingerprint);
  assert.equal(second.turnChanged, false);
  assert.equal(second.textChanged, true);
});

test("consecutive assistant turns with identical text receive different turn IDs", () => {
  const a = createTurn({ key: "a", text: "DONE", order: 1 });
  const b = createTurn({ key: "b", text: "DONE", order: 2 });
  const { tracker, documentRef } = trackerHarness([a]);
  const first = tracker.getSnapshot();
  documentRef.setTurns([a, b]);
  const second = tracker.getSnapshot();

  assert.notEqual(first.latestTurnId, second.latestTurnId);
  assert.equal(first.latestTextFingerprint, second.latestTextFingerprint);
  assert.equal(second.turnChanged, true);
});

test("stable DOM turn identifier preserves identity across element replacement", () => {
  const original = createTurn({ key: "same", text: "PLAN", order: 1 });
  const replacement = createTurn({ key: "same", text: "PLAN updated", order: 1 });
  const { tracker, documentRef } = trackerHarness([original]);
  const first = tracker.getSnapshot();
  documentRef.setTurns([replacement]);
  const second = tracker.getSnapshot();

  assert.equal(second.ok, true);
  assert.equal(second.latestTurnId, first.latestTurnId);
  assert.equal(second.textChanged, true);
  assert.equal(second.latestIdentitySource, "dom-attribute");
});

test("text equality alone never proves turn identity across a rerender", () => {
  const original = createTurn({ key: "x", text: "same text", order: 1, stable: false });
  const replacement = createTurn({ key: "y", text: "same text", order: 1, stable: false });
  const { tracker, documentRef } = trackerHarness([original]);
  tracker.getSnapshot();
  documentRef.setTurns([replacement]);
  const second = tracker.getSnapshot();
  assert.equal(second.ok, false);
  assert.equal(second.reason, "assistant_turn_identity_ambiguous");
});

test("structural anchors preserve an unstable turn without relying on its text", () => {
  const before = createTurn({ key: "before", text: "before", order: 1 });
  const unstable = createTurn({ key: "unstable", text: "draft", order: 2, stable: false });
  const after = createTurn({ key: "after", text: "after", order: 3 });
  const replacement = createTurn({ key: "replacement", text: "completely different", order: 2, stable: false });
  const { tracker, documentRef } = trackerHarness([before, unstable, after]);
  const first = tracker.getSnapshot();
  const unstableId = first.turns[1].turnId;

  documentRef.setTurns([before, replacement, after]);
  const second = tracker.getSnapshot();

  assert.equal(second.ok, true);
  assert.equal(second.turns[1].turnId, unstableId);
  assert.equal(second.turns[1].identitySource, "structural");
  assert.notEqual(second.turns[1].textFingerprint, first.turns[1].textFingerprint);
});

test("virtualization may reduce mounted count while a newer turn is still detected", () => {
  const turns = ["A", "B", "C", "D", "E", "F"].map((key, index) => createTurn({ key, text: key, order: index + 1 }));
  const { tracker, documentRef } = trackerHarness(turns.slice(0, 5));
  const baseline = tracker.getSnapshot();
  documentRef.setTurns(turns.slice(3));
  const next = tracker.getSnapshot();

  assert.equal(baseline.mountedTurnCount, 5);
  assert.equal(next.mountedTurnCount, 3);
  assert.equal(next.latestText, "F");
  assert.notEqual(next.latestTurnId, baseline.latestTurnId);
  assert.equal(next.turnChanged, true);
});

test("temporary duplicate nodes with the same stable identity remain one logical turn", () => {
  const oldCopy = createTurn({ key: "dup", text: "PART", order: 1 });
  const activeCopy = createTurn({ key: "dup", text: "PARTIAL RESPONSE", order: 2 });
  const { tracker } = trackerHarness([oldCopy, activeCopy]);
  const snapshot = tracker.getSnapshot();
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.mountedTurnCount, 1);
  assert.equal(snapshot.latestText, "PARTIAL RESPONSE");
});

test("conversation navigation rebases tracker state instead of emitting a stale turn change", () => {
  const firstTurn = createTurn({ key: "1", text: "old", order: 1 });
  const secondTurn = createTurn({ key: "2", text: "existing in next chat", order: 1 });
  const { tracker, documentRef, locationRef } = trackerHarness([firstTurn], { pathname: "/c/one" });
  tracker.getSnapshot();

  locationRef.pathname = "/c/two";
  documentRef.setTurns([secondTurn]);
  const next = tracker.getSnapshot();

  assert.equal(next.ok, true);
  assert.equal(next.conversationChanged, true);
  assert.equal(next.conversationKey, "/c/two");
  assert.equal(next.turnChanged, false);
});

test("late initial hydration is marked as baseline evidence, not inherently as a new completion", () => {
  const turn = createTurn({ key: "hydrated", text: "historical response", order: 1 });
  const { tracker, documentRef } = trackerHarness([]);
  const empty = tracker.getSnapshot();
  assert.equal(empty.latestTurnId, "");

  documentRef.setTurns([turn]);
  const hydrated = tracker.getSnapshot();
  assert.equal(hydrated.ok, true);
  assert.equal(hydrated.hydrationCandidate, true);
  assert.equal(hydrated.turnChanged, false);
});

test("empty assistant shell already owns the stable turn identity before text appears", () => {
  const shell = createTurn({ key: "shell", text: "", order: 1 });
  const { tracker } = trackerHarness([shell]);
  const empty = tracker.getSnapshot();
  setText(shell, "response");
  const filled = tracker.getSnapshot();
  assert.ok(empty.latestTurnId);
  assert.equal(filled.latestTurnId, empty.latestTurnId);
  assert.equal(filled.textChanged, true);
});

test("markdown descendants and code blocks do not create extra logical turns", () => {
  const turn = createTurn({ key: "markdown", text: "Answer\nconst x = 1;", order: 1, nestedBodies: true });
  const { tracker } = trackerHarness([turn]);
  const snapshot = tracker.getSnapshot();
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.turns.length, 1);
  assert.equal(snapshot.latestText, "Answer\nconst x = 1;");
});

test("genuinely unprovable rerender lineage fails closed", () => {
  const firstTurn = createTurn({ key: "a", text: "old text", order: 1, stable: false });
  const replacement = createTurn({ key: "b", text: "different text", order: 1, stable: false });
  const { tracker, documentRef } = trackerHarness([firstTurn]);
  assert.equal(tracker.getSnapshot().ok, true);
  documentRef.setTurns([replacement]);
  const ambiguous = tracker.getSnapshot();
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.reason, "assistant_turn_identity_ambiguous");
});

test("disconnected turns with no provable document order fail closed", () => {
  const a = createTurn({ key: "a", text: "A", order: 1, disconnected: true });
  const b = createTurn({ key: "b", text: "B", order: 2, disconnected: true });
  const { tracker, documentRef } = trackerHarness([a, b]);
  documentRef.setExposeRootOrder(false);
  const snapshot = tracker.getSnapshot();
  assert.equal(snapshot.ok, false);
  assert.equal(snapshot.reason, "assistant_turn_order_ambiguous");
});

test("non-assistant conversation roots are rejected even if root selectors discover them", () => {
  const user = createTurn({ key: "user", text: "prompt", order: 1, role: "user" });
  const assistant = createTurn({ key: "assistant", text: "reply", order: 2 });
  const { tracker } = trackerHarness([user, assistant]);
  const snapshot = tracker.getSnapshot();
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.turns.length, 1);
  assert.equal(snapshot.latestText, "reply");
});

test("identity registry and retained reconciliation history stay bounded", () => {
  const first = createTurn({ key: "0", text: "0", order: 1 });
  const { tracker, documentRef } = trackerHarness([first], { maxHistory: 8 });
  tracker.getSnapshot();
  for (let index = 1; index < 30; index += 1) {
    documentRef.setTurns([createTurn({ key: String(index), text: String(index), order: 1 })]);
    const snapshot = tracker.getSnapshot();
    assert.equal(snapshot.ok, true);
  }
  assert.ok(tracker.identityRegistry.size <= 8);
  assert.ok(tracker.previousTurns.length <= 8);
});

function groupedFixture(key, { userText = "private user prompt", answer = "DONE", role = "assistant", markerOnly = false } = {}) {
  const userBody = { innerText: userText, textContent: userText };
  const assistantBody = { innerText: answer, textContent: answer };
  let group;
  const assistantNode = {
    innerText: answer,
    textContent: answer,
    closest() { return group; },
    querySelectorAll(selector) {
      return selector === ".markdown" ? [assistantBody] : [];
    },
    compareDocumentPosition(other) {
      return other === userBody ? 2 : 0;
    }
  };
  const startMarker = {
    closest() { return group; },
    compareDocumentPosition(other) { return other === assistantBody ? 4 : 0; }
  };
  group = {
    innerText: userText + "\n" + answer,
    textContent: userText + "\n" + answer,
    closest() { return this; },
    getAttribute(name) {
      return name === "data-turn-key" ? key : "";
    },
    matches() { return false; },
    querySelectorAll(selector) {
      if (selector === '[data-conversation-role="assistant"]') {
        return role === "assistant" && !markerOnly ? [assistantNode] : [];
      }
      if (selector === "[data-chatgpt-agent-turn-start]") {
        return role === "assistant" && markerOnly ? [startMarker] : [];
      }
      if (selector === ".markdown") return [userBody, assistantBody];
      return [];
    }
  };
  return { group, assistantNode, startMarker, assistantBody, userBody };
}

function groupedHarness(fixture, pathname = "/c/grouped") {
  const doc = {
    querySelectorAll(selector) {
      if (selector.includes(",")) return [fixture.group];
      if (selector === '[data-turn-key]:has([data-conversation-role="assistant"], [data-chatgpt-agent-turn-start])') {
        return fixture.group.querySelectorAll('[data-conversation-role="assistant"]').length
          || fixture.group.querySelectorAll('[data-chatgpt-agent-turn-start]').length
          ? [fixture.group] : [];
      }
      if (selector === '[data-conversation-role="assistant"]') {
        return fixture.group.querySelectorAll(selector);
      }
      if (selector === "[data-chatgpt-agent-turn-start]") {
        return fixture.group.querySelectorAll(selector);
      }
      return [];
    }
  };
  return { tracker: new AssistantTurnTracker({
    documentRef: doc,
    locationRef: { pathname },
    selectors: require("../content/selectors.js")
  }), doc };
}

test("new grouped ChatGPT renderer tracks assistant content but never includes user text", () => {
  const fixture = groupedFixture("stable-user-group", { userText: "SECRET PROMPT", answer: "DONE" });
  const { tracker } = groupedHarness(fixture);
  const first = tracker.getSnapshot();
  assert.equal(first.ok, true);
  assert.equal(first.mountedTurnCount, 1);
  assert.equal(first.latestText, "DONE");
  assert.equal(first.latestText.includes("SECRET PROMPT"), false);
  assert.equal(first.latestIdentitySource, "dom-attribute");
  fixture.assistantBody.innerText = "DONE UPDATED";
  fixture.assistantBody.textContent = "DONE UPDATED";
  const next = tracker.getSnapshot();
  assert.equal(next.latestTurnId, first.latestTurnId);
  assert.equal(next.latestText, "DONE UPDATED");
  assert.equal(next.textChanged, true);
});

test("group marker alone creates identity but does not leak user prompt as assistant text", () => {
  const fixture = groupedFixture("user-group-marker", { userText: "DO NOT PUBLISH", answer: "", markerOnly: true });
  const { tracker } = groupedHarness(fixture);
  const snapshot = tracker.getSnapshot();
  assert.equal(snapshot.ok, true);
  assert.ok(snapshot.latestTurnId);
  assert.equal(snapshot.latestText, "");
});

test("group without assistant markers is not treated as a response", () => {
  const fixture = groupedFixture("user-only", { role: "user", userText: "User question" });
  const { tracker } = groupedHarness(fixture);
  const snapshot = tracker.getSnapshot();
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.mountedTurnCount, 0);
  assert.equal(snapshot.latestTurnId, "");
});

test("turn IDs never contain assistant response text", () => {
  const turn = createTurn({ key: "privacy", text: "super secret response contents", order: 1 });
  const { tracker } = trackerHarness([turn]);
  const snapshot = tracker.getSnapshot();
  assert.ok(snapshot.latestTurnId);
  assert.equal(snapshot.latestTurnId.includes("super secret"), false);
});
