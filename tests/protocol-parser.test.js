const test = require("node:test");
const assert = require("node:assert/strict");

require("../content/utils.js");
require("../protocol/orchestra-protocol.js");
const ProtocolParser = require("../content/protocol-parser.js");

const parser = new ProtocolParser();
const rules = [
  { id: "done", enabled: true, marker: "DONE", action: "prompt" },
  { id: "fail", enabled: true, marker: "FAIL", action: "notify" },
  { id: "disabled", enabled: false, marker: "SKIP", action: "prompt" }
];

function envelope(overrides = {}) {
  return {
    v: 1,
    event: "DONE",
    projectId: "P1",
    taskId: "T1",
    runId: "R1",
    agentId: "A1",
    eventId: "E1",
    sequence: 1,
    payload: {},
    ...overrides
  };
}

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

test("parses a valid @@ORCH envelope only from the final non-empty line", () => {
  const valid = `@@ORCH ${JSON.stringify(envelope())}`;
  const result = parser.parse(`ordinary prose\n${valid}\n`, { rules });
  assert.equal(result.kind, "orchestra_event");
  assert.equal(result.event.eventId, "E1");
  assert.equal(result.route, "completion");

  const notFinal = parser.parse(`${valid}\nordinary prose`, { rules });
  assert.equal(notFinal.kind, "unrecognized");
});

test("malformed @@ORCH is a protocol_error and never falls through to legacy", () => {
  const result = parser.parse("DONE\n@@ORCH {bad json", { rules });
  assert.equal(result.kind, "protocol_error");
  assert.equal(result.reason, "invalid_json");
});

test("incomplete protocol identity is rejected", () => {
  const result = parser.parse('@@ORCH {"v":1,"event":"DONE"}', { rules });
  assert.equal(result.kind, "protocol_error");
  assert.equal(result.reason, "invalid_required_field");
});

test("returns none for an empty response", () => {
  assert.equal(parser.parse(" \n\n", { rules }).kind, "none");
});
