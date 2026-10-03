const test = require("node:test");
const assert = require("node:assert/strict");

const Lifecycle = require("../platform/agent-lifecycle.js");

function agent(status = "CONNECTING", overrides = {}) {
  return {
    agentId: "A1",
    role: "worker",
    status,
    sessionId: "session-1",
    lastSeenAt: 0,
    ...overrides
  };
}

test("legacy AgentRuntime status maps into the canonical lifecycle", () => {
  const cases = [
    ["IDLE", "READY"],
    ["BUSY", "BUSY"],
    ["CONNECTING", "UNAVAILABLE"],
    ["OFFLINE", "UNAVAILABLE"]
  ];
  for (const [status, expected] of cases) {
    const value = agent(status);
    Lifecycle.initializeAgentLifecycle(value, { at: 100 });
    assert.equal(value.lifecycleState, expected);
  }

  const recoverable = agent("ERROR", { lastError: "page_unreachable" });
  Lifecycle.initializeAgentLifecycle(recoverable, { at: 100 });
  assert.equal(recoverable.lifecycleState, "UNAVAILABLE");

  const terminal = agent("ERROR", { lastError: "runtime_incompatible" });
  Lifecycle.initializeAgentLifecycle(terminal, { at: 100 });
  assert.equal(terminal.lifecycleState, "FAILED");
});

test("canonical transition policy rejects invalid and implicit FAILED recovery transitions", () => {
  const value = agent("CONNECTING");
  Lifecycle.initializeAgentLifecycle(value, { at: 100 });
  assert.equal(value.lifecycleState, "UNAVAILABLE");

  assert.equal(Lifecycle.transitionAgentLifecycle(value, "BUSY", { at: 110, reason: "prompt_active" }).rejected, true);
  assert.equal(value.lifecycleState, "UNAVAILABLE");

  assert.equal(Lifecycle.transitionAgentLifecycle(value, "READY", {
    at: 120,
    reason: "prompt_ready",
    readinessCheckedAt: 120
  }).rejected, false);
  assert.equal(value.lifecycleState, "READY");

  assert.equal(Lifecycle.transitionAgentLifecycle(value, "BUSY", { at: 130, reason: "prompt_active" }).rejected, false);
  assert.equal(value.lifecycleState, "BUSY");

  assert.equal(Lifecycle.transitionAgentLifecycle(value, "FAILED", {
    at: 140,
    reason: "runtime_failure",
    details: { terminal: true }
  }).rejected, false);
  assert.equal(value.lifecycleState, "FAILED");

  assert.equal(Lifecycle.transitionAgentLifecycle(value, "READY", {
    at: 150,
    reason: "recovered",
    readinessCheckedAt: 150
  }).rejected, true);
  assert.equal(value.lifecycleState, "FAILED");

  assert.equal(Lifecycle.transitionAgentLifecycle(value, "UNAVAILABLE", {
    at: 160,
    reason: "recovery_required",
    explicitRecovery: true
  }).rejected, false);
  assert.equal(value.lifecycleState, "UNAVAILABLE");
});

test("direct FAILED to READY requires explicit validated recovery", () => {
  const value = agent("ERROR", { lastError: "runtime_failure" });
  Lifecycle.initializeAgentLifecycle(value, { at: 100 });
  assert.equal(value.lifecycleState, "FAILED");

  assert.equal(Lifecycle.transitionAgentLifecycle(value, "READY", {
    at: 110,
    reason: "recovered",
    explicitRecovery: true,
    validated: false
  }).rejected, true);

  assert.equal(Lifecycle.transitionAgentLifecycle(value, "READY", {
    at: 120,
    reason: "recovered",
    explicitRecovery: true,
    validated: true,
    readinessCheckedAt: 120
  }).rejected, false);
  assert.equal(value.lifecycleState, "READY");
});

test("READY is freshness-bound and stale readiness is not dispatchable", () => {
  const value = agent("IDLE", { readinessCheckedAt: 1000, lifecycleState: "READY", lifecycleReason: "prompt_ready" });
  Lifecycle.initializeAgentLifecycle(value, { at: 1000 });
  assert.equal(Lifecycle.isReady(value, { now: 1029, readinessTtlMs: 30 }), true);
  assert.equal(Lifecycle.isReady(value, { now: 1031, readinessTtlMs: 30 }), false);
});

test("heartbeat normalization keeps browser details outside Core lifecycle decisions", () => {
  assert.deepEqual(
    Lifecycle.normalizeHeartbeat({ availability: "ready", generating: false, composerOccupied: false }),
    { state: "READY", reason: "prompt_ready", legacyStatus: "IDLE" }
  );
  assert.deepEqual(
    Lifecycle.normalizeHeartbeat({ availability: "ready", generating: false, composerOccupied: true }),
    { state: "UNAVAILABLE", reason: "composer_unavailable", legacyStatus: "ERROR" }
  );
  assert.deepEqual(
    Lifecycle.normalizeHeartbeat({ availability: "generating", generating: true }),
    { state: "BUSY", reason: "prompt_active", legacyStatus: "BUSY" }
  );
  assert.deepEqual(
    Lifecycle.normalizeHeartbeat({ availability: "unavailable" }),
    { state: "UNAVAILABLE", reason: "page_unreachable", legacyStatus: "ERROR" }
  );
});
