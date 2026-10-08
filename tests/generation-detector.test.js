const test = require("node:test");
const assert = require("node:assert/strict");

require("../content/generation-state.js");
const GenerationDetector = require("../content/generation-detector.js");

function logger() {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

function createDetectorHarness({ hydrationGraceMs = 2000, quietMs = 500 } = {}) {
  let now = 0;
  let busy = false;
  let snapshot = {
    pathname: "/c/first",
    fingerprint: "first-old",
    latestTurnId: "turn-a",
    latestTextFingerprint: "text-a",
    messageCount: 3,
    text: "DONE"
  };

  const detector = new GenerationDetector({
    documentRef: {},
    windowRef: {},
    reader: { getSnapshot: () => snapshot },
    composer: { isGenerating: () => busy },
    logger: logger(),
    quietMs,
    hydrationGraceMs,
    clock: () => now
  });

  const events = [];
  detector.onEvent((event) => events.push(event.type));
  detector.started = true;

  return {
    detector,
    events,
    setNow(value) { now = value; },
    setBusy(value) { busy = value; },
    setSnapshot(value) { snapshot = value; }
  };
}

test("SPA navigation establishes a fresh baseline instead of completing an old response", () => {
  const harness = createDetectorHarness();

  harness.detector.inspect("startup");
  assert.deepEqual(harness.events, []);

  harness.setNow(100);
  harness.setSnapshot({
    pathname: "/c/second",
    fingerprint: "second-existing",
    messageCount: 9,
    text: "DONE"
  });
  harness.detector.inspect("navigation");
  assert.deepEqual(harness.events, ["conversation_changed"]);

  harness.setNow(5000);
  harness.detector.inspect("poll");
  assert.equal(harness.events.includes("generation_completed"), false);
});

test("late hydration of an existing response refreshes baseline without completion", () => {
  const harness = createDetectorHarness({ hydrationGraceMs: 2000 });

  harness.detector.inspect("startup");

  harness.setNow(300);
  harness.setSnapshot({
    pathname: "/c/first",
    fingerprint: "hydrated-old-response",
    messageCount: 8,
    text: "DONE"
  });
  harness.detector.inspect("hydration");

  harness.setNow(3000);
  harness.detector.inspect("poll");
  assert.equal(harness.events.includes("generation_completed"), false);
});

test("fingerprint-only fallback completes a new response after hydration grace", () => {
  const harness = createDetectorHarness({ hydrationGraceMs: 1000, quietMs: 500 });
  harness.detector.inspect("startup");

  harness.setNow(1500);
  harness.setSnapshot({
    pathname: "/c/first",
    fingerprint: "new-response",
    messageCount: 4,
    text: "DONE"
  });
  harness.detector.inspect("mutation");
  assert.equal(harness.events.includes("generation_completed"), false);

  harness.setNow(2001);
  harness.detector.inspect("poll");
  assert.equal(harness.events.includes("generation_completed"), true);
});

test("explicit busy signal works immediately even inside hydration grace", () => {
  const harness = createDetectorHarness({ hydrationGraceMs: 5000, quietMs: 300 });
  harness.detector.inspect("startup");

  harness.setNow(100);
  harness.setBusy(true);
  harness.detector.inspect("busy");
  assert.equal(harness.events.includes("generation_started"), true);

  harness.setNow(200);
  harness.setSnapshot({
    pathname: "/c/first",
    fingerprint: "busy-new-response",
    messageCount: 4,
    text: "DONE"
  });
  harness.setBusy(false);
  harness.detector.inspect("stop");

  harness.setNow(501);
  harness.detector.inspect("settled");
  assert.equal(harness.events.includes("generation_completed"), true);
});


test("detector distinguishes a new assistant turn from text changes within the same turn", () => {
  const harness = createDetectorHarness({ hydrationGraceMs: 0, quietMs: 500 });
  harness.detector.inspect("startup");

  harness.setNow(100);
  harness.setSnapshot({
    pathname: "/c/first",
    fingerprint: "turn-a-streaming",
    latestTurnId: "turn-a",
    latestTextFingerprint: "text-a-v2",
    messageCount: 3,
    text: "DONE more"
  });
  harness.detector.inspect("stream");
  assert.equal(harness.events.includes("assistant_turn_changed"), true);
  assert.equal(harness.events.includes("assistant_turn_started"), false);

  harness.setNow(200);
  harness.setSnapshot({
    pathname: "/c/first",
    fingerprint: "turn-b",
    latestTurnId: "turn-b",
    latestTextFingerprint: "text-a-v2",
    messageCount: 2,
    text: "DONE more"
  });
  harness.detector.inspect("new-turn");
  assert.equal(harness.events.includes("assistant_turn_started"), true);
});

test("detector fails closed on ambiguous turn lineage", () => {
  const harness = createDetectorHarness({ hydrationGraceMs: 0 });
  harness.detector.inspect("startup");

  harness.setNow(100);
  harness.setSnapshot({
    ok: false,
    reason: "assistant_turn_identity_ambiguous",
    pathname: "/c/first",
    observedTurnCount: 4
  });
  harness.detector.inspect("mutation");

  assert.equal(harness.events.includes("assistant_turn_ambiguous"), true);
  assert.equal(harness.events.includes("generation_completed"), false);
});
