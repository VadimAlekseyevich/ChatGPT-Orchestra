const test = require("node:test");
const assert = require("node:assert/strict");

const Protocol = require("../platform/companion-protocol.js");

test("companion protocol creates bounded versioned request/response/event frames", () => {
  const request = Protocol.request("r1", "agent.snapshot", { includeHealth: true });
  assert.deepEqual(request, { v: 1, kind: "request", id: "r1", method: "agent.snapshot", payload: { includeHealth: true } });

  const response = Protocol.response("r1", { ok: true });
  assert.equal(response.replyTo, "r1");
  assert.equal(response.ok, true);

  const event = Protocol.event("e1", "bridge.status", { connected: true });
  assert.equal(event.event, "bridge.status");
  assert.equal(Protocol.validateFrame(event).v, Protocol.PROTOCOL_VERSION);
});

test("companion protocol rejects incompatible, malformed and oversized frames", () => {
  assert.throws(() => Protocol.validateFrame({ v: 99, kind: "event", id: "e", event: "x", payload: null }), /version_mismatch/);
  assert.throws(() => Protocol.validateFrame({ v: 1, kind: "request", id: "", method: "x", payload: null }), /request_id_invalid/);
  assert.throws(() => Protocol.validateFrame({ v: 1, kind: "response", replyTo: "r", ok: false }), /response_error_invalid/);
  assert.throws(
    () => Protocol.validateFrame({ v: 1, kind: "event", id: "e", event: "x", payload: { text: "a".repeat(300000) } }),
    /frame_too_large/
  );
});