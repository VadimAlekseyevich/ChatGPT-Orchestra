const test = require("node:test");
const assert = require("node:assert/strict");

const { ContextStore, STORAGE_KEY } = require("../background/context-store.js");

function clone(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }

class StorageArea {
  constructor(seed = {}) { this.data = clone(seed); }
  async get(keys) {
    const list = Array.isArray(keys) ? keys : [keys];
    const output = {};
    for (const key of list) if (Object.prototype.hasOwnProperty.call(this.data, key)) output[key] = clone(this.data[key]);
    return output;
  }
  async set(values) { Object.assign(this.data, clone(values)); }
}

test("ContextStore persists lead summary and bounded registers across reload", async () => {
  const storage = new StorageArea();
  const store = new ContextStore({ storageArea: storage, clock: () => 100 });
  const decisions = Array.from({ length: 150 }, (_, index) => ({ decisionId: `D${index}`, at: index }));
  await store.setContext("P1", { leadSummary: { projectId: "P1", status: "RUNNING" }, decisions });
  for (let index = 0; index < 205; index += 1) store.recordPacketInMemory("P1", { packetType: "task", logicalRoleId: `T${index}`, generatedAt: index });
  await store.persist();

  const reloaded = new ContextStore({ storageArea: storage, clock: () => 200 });
  await reloaded.load();
  const snapshot = reloaded.snapshot();
  assert.equal(snapshot.projectId, "P1");
  assert.equal(snapshot.leadSummary.status, "RUNNING");
  assert.equal(snapshot.decisions.length, 120);
  assert.equal(snapshot.decisions[0].decisionId, "D30");
  assert.equal(snapshot.packetAudit.length, 200);
  assert.equal(snapshot.packetAudit[0].logicalRoleId, "T5");
  assert.equal(storage.data[STORAGE_KEY].projectId, "P1");
});

test("switching project resets stale context instead of leaking old project memory", async () => {
  const storage = new StorageArea();
  const store = new ContextStore({ storageArea: storage, clock: () => 10 });
  await store.setContext("P1", { leadSummary: { projectId: "P1", secretOldSummary: "old" }, decisions: [{ decisionId: "OLD" }] });
  await store.ensureProject("P2");
  const snapshot = store.snapshot();
  assert.equal(snapshot.projectId, "P2");
  assert.equal(snapshot.leadSummary, null);
  assert.deepEqual(snapshot.decisions, []);
  assert.deepEqual(snapshot.packetAudit, []);
});
