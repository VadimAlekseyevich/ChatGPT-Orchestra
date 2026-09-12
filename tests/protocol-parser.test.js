const test = require("node:test");
const assert = require("node:assert/strict");

require("../content/utils.js");
const ProtocolParser = require("../content/protocol-parser.js");

const parser = new ProtocolParser();
const rules = [
  { id: "done", enabled: true, marker: "DONE", action: "prompt" },
  { id: "fail", enabled: true, marker: "FAIL", action: "notify" },
  { id: "disabled", enabled: false, marker: "SKIP", action: "prompt" }
];

test("matches an exact legacy marker on the last non-empty line", () => {
  const result = parser.parse("Work complete\n\nDONE\n", { rules });
  assert.equal(result.kind, "legacy_rule");
  assert.equal(result.rule.id, "done");
});

test("does not accept punctuation or different case for legacy markers", () => {
  assert.equal(parser.parse("DONE.", { rules }).kind, "unrecognized");
  assert.equal(parser.parse("done", { rules }).kind, "unrecognized");
});

test("ignores disabled rules", () => {
  assert.equal(parser.parse("SKIP", { rules }).kind, "unrecognized");
});

test("reserves @@ORCH lines for the future formal protocol", () => {
  const result = parser.parse('answer\n@@ORCH {"v":1,"event":"DONE"}', { rules });
  assert.equal(result.kind, "orchestra_candidate");
  assert.match(result.raw, /^@@ORCH/);
});

test("returns none for an empty response", () => {
  assert.equal(parser.parse(" \n\n", { rules }).kind, "none");
});
