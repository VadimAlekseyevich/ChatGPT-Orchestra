const test = require("node:test");
const assert = require("node:assert/strict");

require("../content/generation-state.js");
const GenerationDetector = require("../content/generation-detector.js");

function logger() {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

test("SPA navigation establishes a fresh baseline instead of completing an old response", () => {
  let now = 0;
  let snapshot = {
    pathname: "/c/first",
    fingerprint: "first-old",
    messageCount: 3,
    text: "DONE"
  };

  const detector = new GenerationDetector({
    documentRef: {},
    windowRef: {},
    reader: { getSnapshot: () => snapshot },
    composer: { isGenerating: () => false },
    logger: logger(),
    quietMs: 500,
    clock: () => now
  });

  const events = [];
  detector.onEvent((event) => events.push(event.type));
  detector.started = true;

  detector.inspect("startup");
  assert.deepEqual(events, []);

  now = 100;
  snapshot = {
    pathname: "/c/second",
    fingerprint: "second-existing",
    messageCount: 9,
    text: "DONE"
  };
  detector.inspect("navigation");
  assert.deepEqual(events, ["conversation_changed"]);

  now = 2000;
  detector.inspect("poll");
  assert.equal(events.includes("generation_completed"), false);
});
