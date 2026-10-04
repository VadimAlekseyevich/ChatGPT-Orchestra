const test = require("node:test");
const assert = require("node:assert/strict");

require("../protocol/orchestra-protocol.js");
const { FakeAgentRuntime, MemoryStateStore } = require("../platform/fake-runtime.js");
const { EventStore } = require("../background/event-store.js");
const { EventBus } = require("../background/event-bus.js");

async function setup() {
  const runtime = new FakeAgentRuntime({
    agents: [{ agentId: "A1", role: "worker", status: "IDLE" }]
  });
  const store = new EventStore({ stateStore: new MemoryStateStore() });
  const bus = new EventBus({ registry: runtime, store, logger: { warn() {} } });
  await bus.load();
  return {
    runtime,
    store,
    bus,
    sender: { agentId: "A1", runtimeKind: "fake", bindingPresent: true }
  };
}

function integrationEvent(overrides = {}) {
  return {
    v: 1,
    event: "CONFLICT",
    projectId: "P1",
    taskId: "integration",
    runId: "I1",
    agentId: "A1",
    eventId: "I1-conflict-1",
    sequence: 1,
    payload: { conflictType: "text", files: ["src/a.js"] },
    ...overrides
  };
}

test("unbound integration event is rejected before it can reserve eventId", async () => {
  const { runtime, store, bus, sender } = await setup();
  const rejected = await bus.handleEvent(integrationEvent(), sender);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, "integration_context_required");
  assert.equal(store.getProcessed("I1-conflict-1"), null);

  await runtime.setProtocolContext("A1", { projectId: "P1", taskId: "integration", runId: "I1" });
  const accepted = await bus.handleEvent(integrationEvent(), sender);
  assert.equal(accepted.accepted, true);
  assert.ok(store.getProcessed("I1-conflict-1"));
});

test("integration DONE also requires exact bound integration context", async () => {
  const { runtime, bus, sender } = await setup();
  await runtime.setProtocolContext("A1", { projectId: "P1", taskId: "integration", runId: "I1" });
  const wrong = await bus.handleEvent(integrationEvent({ event: "DONE", runId: "OTHER", eventId: "done-other", payload: {} }), sender);
  assert.equal(wrong.reason, "runId_mismatch");
  const ok = await bus.handleEvent(integrationEvent({ event: "DONE", eventId: "done-ok", payload: {} }), sender);
  assert.equal(ok.accepted, true);
  assert.equal(ok.route, "completion");
});
