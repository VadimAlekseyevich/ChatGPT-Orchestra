const test = require("node:test");
const assert = require("node:assert/strict");
const { RecoveryStore } = require("../background/recovery-store.js");

function fakeStorage() {
  const data = {};
  return {
    data,
    async get(key) { return { [key]: data[key] }; },
    async set(values) { Object.assign(data, values); }
  };
}

test("recovery control plane persists pause and resume transitions", async () => {
  let now = 100;
  const storage = fakeStorage();
  const store = new RecoveryStore({ storageArea: storage, clock: () => now++ });
  await store.load();
  await store.attachProject("P1", { status: "RUNNING" });
  await store.transition("PAUSING", { reason: "user_pause", snapshot: { active: 2 } });
  assert.equal(store.summary().status, "PAUSING");
  assert.equal(store.summary().snapshot.active, 2);
  await store.transition("PAUSED", { reason: "safe_point", snapshot: { active: 0 } });
  assert.equal(store.summary().status, "PAUSED");
  assert.ok(store.summary().safePointAt);
  await store.transition("RECOVERING", { reason: "user_resume" });
  await store.transition("RUNNING", { reason: "reconciled", reconciled: true });
  assert.equal(store.summary().status, "RUNNING");
  assert.ok(store.summary().lastReconciledAt);

  const restored = new RecoveryStore({ storageArea: storage });
  await restored.load();
  assert.equal(restored.summary().projectId, "P1");
  assert.equal(restored.summary().status, "RUNNING");
  assert.equal(restored.summary().snapshotCursor, 2);
});

test("unknown persisted control state fails closed as recovery required", async () => {
  const storage = fakeStorage();
  storage.data["orchestra.recovery.v1"] = {
    schemaVersion: 1,
    projectId: "P1",
    status: "FUTURE_STATE",
    issues: []
  };
  const store = new RecoveryStore({ storageArea: storage });
  await store.load();
  assert.equal(store.summary().status, "RECOVERY_REQUIRED");
});
