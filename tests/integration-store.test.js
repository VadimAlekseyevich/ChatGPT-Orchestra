const test = require("node:test");
const assert = require("node:assert/strict");
const { IntegrationStore } = require("../background/integration-store.js");

function fakeStorage() {
  const data = {};
  return { data, async get(key) { return { [key]: data[key] }; }, async set(values) { Object.assign(data, values); } };
}

function runSpec() {
  return {
    projectId: "P1",
    runId: "I1",
    branch: "orchestra/P1/integration/I1",
    baseSha: "a".repeat(40),
    targetBranch: "main",
    taskOrder: ["T1", "T2"],
    mergeTaskIds: ["T1", "T2"],
    artifacts: [
      { taskId: "T1", branch: "b1", commit: "b".repeat(40), changedFiles: ["src/a.js"] },
      { taskId: "T2", branch: "b2", commit: "c".repeat(40), changedFiles: ["src/b.js"] }
    ],
    verificationCommands: ["npm test"]
  };
}

async function seedActiveRepair(store) {
  await store.createRun(runSpec());
  await store.assign("I1", "A3");
  await store.markRunning("I1");
  await store.recordConflict("I1", { conflictType: "text", files: ["src/a.js"], mergedTaskIds: [] }, ["T1"]);
  const repair = await store.createRepairTask("I1", {
    conflict: { conflictType: "text", files: ["src/a.js"] },
    responsibleTaskIds: ["T1"],
    nextSequence: 2
  });
  await store.markRepairActive(repair.repairTask.repairTaskId);
  return repair.repairTask.repairTaskId;
}

test("persists integration run, conflict and bounded repair task", async () => {
  const storage = fakeStorage();
  let repairId = 0;
  const store = new IntegrationStore({ storageArea: storage, idFactory: () => `R${++repairId}` });
  await store.load();
  const repairTaskId = await seedActiveRepair(store);
  assert.equal(repairTaskId, "integration-repair-R1");
  assert.equal(store.currentRun().status, "REPAIRING");

  const restored = new IntegrationStore({ storageArea: storage });
  await restored.load();
  assert.equal(restored.currentRun().agentId, "A3");
  assert.equal(restored.listRepairs()[0].status, "ACTIVE");
  assert.equal(restored.summary().settings.targetPolicy, "integration_branch_only");
});

test("repair budget fails closed", async () => {
  const store = new IntegrationStore({ storageArea: fakeStorage(), idFactory: (() => { let id = 0; return () => `R${++id}`; })() });
  await store.load();
  await store.ensureProject("P1", { maxRepairAttempts: 1 });
  await store.createRun(runSpec());
  const first = await store.createRepairTask("I1", { conflict: {}, responsibleTaskIds: ["T1"], nextSequence: 2 });
  assert.equal(first.ok, true);
  const second = await store.createRepairTask("I1", { conflict: {}, responsibleTaskIds: ["T1"], nextSequence: 3 });
  assert.equal(second.ok, false);
  assert.equal(second.reason, "integration_repair_budget_exhausted");
});

test("completion stores verified summary without changing target policy", async () => {
  const store = new IntegrationStore({ storageArea: fakeStorage() });
  await store.load();
  await store.createRun(runSpec());
  await store.complete("I1", { branch: "orchestra/P1/integration/I1", commit: "d".repeat(40) });
  assert.equal(store.summary().status, "INTEGRATION_VERIFIED");
  assert.equal(store.summary().summary.commit, "d".repeat(40));
  assert.equal(store.summary().settings.targetPolicy, "integration_branch_only");
});

test("abandon terminalizes an active repair record", async () => {
  const store = new IntegrationStore({ storageArea: fakeStorage(), idFactory: () => "R1" });
  await store.load();
  const repairTaskId = await seedActiveRepair(store);
  await store.abandon("I1", "integrator_unavailable");
  const repair = store.listRepairs().find((item) => item.repairTaskId === repairTaskId);
  assert.equal(repair.status, "ABANDONED");
  assert.equal(repair.result.outcome, "integration_run_abandoned");
  assert.equal(store.getRun("I1").activeRepairTaskId, null);
});

test("failure terminalizes an active repair record", async () => {
  const store = new IntegrationStore({ storageArea: fakeStorage(), idFactory: () => "R1" });
  await store.load();
  const repairTaskId = await seedActiveRepair(store);
  await store.fail("I1", "semantic_conflict_unresolved", { check: "npm test" });
  const repair = store.listRepairs().find((item) => item.repairTaskId === repairTaskId);
  assert.equal(repair.status, "FAILED");
  assert.equal(repair.result.outcome, "integration_run_failed");
  assert.equal(store.getRun("I1").activeRepairTaskId, null);
});
