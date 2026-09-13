const test = require("node:test");
const assert = require("node:assert/strict");

require("../protocol/orchestra-protocol.js");
require("../platform/contracts.js");
const { MemoryStateStore, FakeAgentRuntime } = require("../platform/fake-runtime.js");
const { EventStore } = require("../background/event-store.js");
const { EventBus } = require("../background/event-bus.js");

function event(overrides = {}) {
  return {
    v: 1,
    event: "DONE",
    projectId: "P1",
    taskId: "T1",
    runId: "R1",
    agentId: "A1",
    eventId: "E1",
    sequence: 1,
    payload: { summary: "done" },
    ...overrides
  };
}

async function setup({ stateStore = new MemoryStateStore() } = {}) {
  const runtime = new FakeAgentRuntime({ agents: [{ agentId: "A1", role: "worker", status: "IDLE", sessionId: "session-7" }] });
  const store = new EventStore({ stateStore });
  const bus = new EventBus({ registry: runtime, store, logger: { warn() {} } });
  await bus.load();
  const sender = runtime.normalizeSender({ agentId: "A1" });
  return { runtime, store, bus, sender, stateStore };
}

test("accepts an event exactly once and treats exact replay as duplicate", async () => {
  const { bus, store, sender } = await setup();
  const source = { responseFingerprint: "fp-1", pathname: "/c/x", messageCount: 8 };
  const first = await bus.handleEvent(event(), sender, source);
  const second = await bus.handleEvent(event(), sender, source);
  assert.equal(first.accepted, true);
  assert.equal(second.duplicate, true);
  assert.equal(store.summary().acceptedEvents, 1);
  const stored = store.recentEvents(1)[0];
  assert.equal(stored.source.responseFingerprint, source.responseFingerprint);
  assert.equal(stored.source.pathname, source.pathname);
  assert.equal(stored.source.messageCount, source.messageCount);
  assert.deepEqual(stored.runtimeSource, { kind: "agent-session", sessionId: "session-7", agentId: "A1" });
});

test("same eventId with changed payload is an id collision", async () => {
  const { bus, sender } = await setup();
  await bus.handleEvent(event(), sender);
  const result = await bus.handleEvent(event({ payload: { summary: "different" } }), sender);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "event_id_collision");
});

test("rejects stale sequence", async () => {
  const { bus, sender } = await setup();
  await bus.handleEvent(event({ eventId: "E2", sequence: 2 }), sender);
  const result = await bus.handleEvent(event({ eventId: "E1", sequence: 1 }), sender);
  assert.equal(result.reason, "stale_sequence");
});

test("rejects wrong agent and unregistered runtime sender", async () => {
  const { bus, sender } = await setup();
  assert.equal((await bus.handleEvent(event({ agentId: "OTHER" }), sender)).reason, "agent_mismatch");
  assert.equal((await bus.handleEvent(event(), { kind: "agent-session", sessionId: "session-99", agentId: null })).reason, "unregistered_sender");
});

test("bound protocol context rejects stale task/run identity", async () => {
  const { runtime, bus, sender } = await setup();
  await runtime.setProtocolContext("A1", { projectId: "P1", taskId: "T2", runId: "R9" });
  assert.equal((await bus.handleEvent(event(), sender)).reason, "taskId_mismatch");
  const ok = await bus.handleEvent(event({ taskId: "T2", runId: "R9" }), sender);
  assert.equal(ok.accepted, true);
});

test("review events require exact bound context before eventId can be reserved", async () => {
  const { runtime, bus, store, sender } = await setup();
  const review = event({ event: "REVIEW_APPROVED", runId: "REV1", eventId: "REV1-final", payload: {} });
  const unbound = await bus.handleEvent(review, sender);
  assert.equal(unbound.ok, false);
  assert.equal(unbound.reason, "review_context_required");
  assert.equal(store.summary().acceptedEvents, 0);

  await runtime.setProtocolContext("A1", { projectId: "P1", taskId: "T1", runId: "REV1" });
  const bound = await bus.handleEvent(review, sender);
  assert.equal(bound.accepted, true);
  assert.equal(store.summary().acceptedEvents, 1);
});

test("persists processed events across portable StateStore reload", async () => {
  const stateStore = new MemoryStateStore();
  const first = await setup({ stateStore });
  await first.bus.handleEvent(event(), first.sender);

  const second = await setup({ stateStore });
  const replay = await second.bus.handleEvent(event(), second.sender);
  assert.equal(replay.duplicate, true);
});
