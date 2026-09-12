const test = require("node:test");
const assert = require("node:assert/strict");
const { EventStore } = require("../background/event-store.js");

function fakeStorage() {
  const data = {};
  return {
    data,
    async get(key) { return { [key]: data[key] }; },
    async set(values) { Object.assign(data, values); }
  };
}

function event() {
  return {
    v: 1,
    event: "DONE",
    projectId: "P1",
    taskId: "planning:discovery",
    runId: "R1",
    agentId: "A1",
    eventId: "E1",
    sequence: 1,
    payload: { stage: "DISCOVERY" }
  };
}

test("persists a bounded planning artifact with accepted event provenance", async () => {
  const store = new EventStore({ storageArea: fakeStorage() });
  await store.load();
  await store.accept(event(), {
    route: "completion",
    tabId: 7,
    source: {
      responseFingerprint: "fp1",
      pathname: "/c/test",
      messageCount: 3,
      planningArtifact: { stack: "JavaScript", commands: ["npm test"] }
    }
  });
  const record = store.recentEvents(1)[0];
  assert.equal(record.source.responseFingerprint, "fp1");
  assert.equal(record.source.planningArtifact.stack, "JavaScript");
  assert.deepEqual(record.source.planningArtifact.commands, ["npm test"]);
});

test("drops oversized planning artifact from event source instead of growing storage without bound", async () => {
  const store = new EventStore({ storageArea: fakeStorage() });
  await store.load();
  await store.accept(event(), {
    route: "completion",
    source: { planningArtifact: { text: "x".repeat(300000) } }
  });
  assert.equal(store.recentEvents(1)[0].source.planningArtifact, null);
});
