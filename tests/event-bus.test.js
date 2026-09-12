const test = require("node:test");
const assert = require("node:assert/strict");

require("../protocol/orchestra-protocol.js");
const { TabRegistry } = require("../background/tab-registry.js");
const { EventStore } = require("../background/event-store.js");
const { EventBus } = require("../background/event-bus.js");

function fakeStorage() {
  const data = {};
  return {
    async get(key) { return { [key]: data[key] }; },
    async set(values) { Object.assign(data, values); }
  };
}

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

async function setup() {
  const registry = new TabRegistry({ storageArea: fakeStorage(), idFactory: () => "A1" });
  await registry.load();
  await registry.createAgent({ role: "worker", tabId: 7, chatUrl: "https://chatgpt.com/" });
  const store = new EventStore({ storageArea: fakeStorage() });
  const bus = new EventBus({ registry, store, logger: { warn() {} } });
  await bus.load();
  return { registry, store, bus, sender: { tab: { id: 7, url: "https://chatgpt.com/c/x" } } };
}

test("accepts an event exactly once and treats exact replay as duplicate", async () => {
  const { bus, store, sender } = await setup();
  const first = await bus.handleEvent(event(), sender);
  const second = await bus.handleEvent(event(), sender);
  assert.equal(first.accepted, true);
  assert.equal(second.duplicate, true);
  assert.equal(store.summary().acceptedEvents, 1);
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

test("rejects wrong agent and unregistered sender", async () => {
  const { bus, sender } = await setup();
  assert.equal((await bus.handleEvent(event({ agentId: "OTHER" }), sender)).reason, "agent_mismatch");
  assert.equal((await bus.handleEvent(event(), { tab: { id: 99 } })).reason, "unregistered_sender");
});

test("bound protocol context rejects stale task/run identity", async () => {
  const { registry, bus, sender } = await setup();
  await registry.setProtocolContext("A1", { projectId: "P1", taskId: "T2", runId: "R9" });
  assert.equal((await bus.handleEvent(event(), sender)).reason, "taskId_mismatch");
  const ok = await bus.handleEvent(event({ taskId: "T2", runId: "R9" }), sender);
  assert.equal(ok.accepted, true);
});

test("persists processed events across store reload", async () => {
  const storage = fakeStorage();
  const registry = new TabRegistry({ storageArea: fakeStorage(), idFactory: () => "A1" });
  await registry.load();
  await registry.createAgent({ role: "worker", tabId: 7, chatUrl: "https://chatgpt.com/" });
  const store1 = new EventStore({ storageArea: storage });
  const bus1 = new EventBus({ registry, store: store1 });
  await bus1.load();
  await bus1.handleEvent(event(), { tab: { id: 7 } });

  const store2 = new EventStore({ storageArea: storage });
  const bus2 = new EventBus({ registry, store: store2 });
  await bus2.load();
  const replay = await bus2.handleEvent(event(), { tab: { id: 7 } });
  assert.equal(replay.duplicate, true);
});
