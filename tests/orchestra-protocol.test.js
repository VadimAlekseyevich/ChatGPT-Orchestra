const test = require("node:test");
const assert = require("node:assert/strict");

const Protocol = require("../protocol/orchestra-protocol.js");

function validEvent(overrides = {}) {
  return {
    v: 1,
    event: "DONE",
    projectId: "P1",
    taskId: "T1",
    runId: "R1",
    agentId: "A1",
    eventId: "E1",
    sequence: 1,
    payload: { commit: "abc123" },
    ...overrides
  };
}

test("parses JSON envelope from final protocol line", () => {
  const line = `@@ORCH ${JSON.stringify(validEvent())}`;
  const result = Protocol.parseLine(line);
  assert.equal(result.ok, true);
  assert.equal(result.event.event, "DONE");
  assert.equal(result.event.payload.commit, "abc123");
});

test("parses compact fallback syntax", () => {
  const line = "@@ORCH|v=1|event=DONE|projectId=P1|taskId=T1|runId=R1|agentId=A1|eventId=E1|sequence=1";
  const result = Protocol.parseLine(line);
  assert.equal(result.ok, true);
  assert.equal(result.event.taskId, "T1");
});

test("rejects duplicate fields in compact syntax", () => {
  const line = "@@ORCH|v=1|event=DONE|projectId=P1|taskId=T1|runId=R1|agentId=A1|eventId=E1|eventId=E2|sequence=1";
  const result = Protocol.parseLine(line);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "duplicate_compact_field");
  assert.equal(result.field, "eventId");
});

test("rejects malformed, oversized and unknown protocol events", () => {
  assert.equal(Protocol.parseLine("@@ORCH {bad").reason, "invalid_json");
  assert.equal(Protocol.parseLine(`@@ORCH ${JSON.stringify(validEvent({ event: "NOPE" }))}`).reason, "unknown_event");
  assert.equal(Protocol.parseLine(`@@ORCH ${"x".repeat(5000)}`).reason, "envelope_too_large");
});

test("requires complete identity and positive sequence", () => {
  assert.equal(Protocol.validateEnvelope(validEvent({ eventId: "" })).reason, "invalid_required_field");
  assert.equal(Protocol.validateEnvelope(validEvent({ sequence: 0 })).reason, "invalid_sequence");
  assert.equal(Protocol.validateEnvelope(validEvent({ v: 2 })).reason, "unsupported_version");
});
