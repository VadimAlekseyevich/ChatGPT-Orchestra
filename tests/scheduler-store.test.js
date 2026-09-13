const test = require("node:test");
const assert = require("node:assert/strict");
const { SchedulerStore } = require("../background/scheduler-store.js");

function fakeStorage() {
  const data = {};
  return { data, async get(key) { return { [key]: data[key] }; }, async set(values) { Object.assign(data, values); } };
}

function project() {
  return {
    projectId: "P1",
    taskGraph: { tasks: [
      { id: "T1", title: "One", kind: "code", dependencies: [], scope: { allow: ["src/a/**"] }, acceptanceCriteria: ["done"], verification: ["npm test"], priority: 10, risk: "low", estimatedComplexity: "S" },
      { id: "T2", title: "Two", kind: "code", dependencies: ["T1"], scope: { allow: ["src/b/**"] }, acceptanceCriteria: ["done"], verification: ["npm test"], priority: 5, risk: "low", estimatedComplexity: "S" }
    ] }
  };
}

function gitAssignment(runId = "R1") {
  return { required: true, provider: "test-git", branch: `orchestra/P1/T1/${runId}`, targetBranch: "main", baseSha: "a".repeat(40) };
}

function validArtifact(runId = "R1") {
  return { ok: true, artifact: { provider: "test-git", branch: `orchestra/P1/T1/${runId}`, commit: "b".repeat(40), baseSha: "a".repeat(40), targetBranch: "main", changedFiles: ["src/a/file.js"] } };
}

async function finishWorker(store, runId = "R1") {
  await store.recordArtifactValidation(runId, validArtifact(runId));
  return store.markDone(runId, { summary: "done", testsPerformed: ["npm test"], knownLimitations: [] });
}

test("dependency stays locked after Worker DONE and unlocks only after review approval", async () => {
  let now = 100;
  const storage = fakeStorage();
  const store = new SchedulerStore({ storageArea: storage, clock: () => now });
  await store.load();
  await store.initializeProject(project(), { maxWorkers: 3, maxRetries: 2 });
  await store.setGitSnapshot({ provider: "test-git", defaultBranch: "main", baseSha: "a".repeat(40) });
  assert.deepEqual(store.runnableTasks().map((task) => task.id), ["T1"]);

  await store.createRun({ taskId: "T1", runId: "R1", agentId: "A1", git: gitAssignment("R1") });
  now += 10;
  await store.markRunning("R1");
  now += 10;
  const done = await finishWorker(store, "R1");
  assert.equal(done.ok, true);
  assert.equal(store.getTask("T1").status, "DONE_BY_WORKER");
  assert.deepEqual(store.runnableTasks().map((task) => task.id), []);

  await store.markReviewPending("T1", "REV1", done.task.workerReport);
  await store.markReviewing("T1", "REV1", "A2");
  await store.markReviewApproved("T1", { reviewId: "REV1", reviewerAgentId: "A2", workerRunId: "R1", iteration: 1, result: { summary: "ok" } });
  assert.equal(store.getTask("T1").status, "APPROVED");
  assert.deepEqual(store.runnableTasks().map((task) => task.id), ["T2"]);

  const restored = new SchedulerStore({ storageArea: storage });
  await restored.load();
  assert.equal(restored.getTask("T1").status, "APPROVED");
  assert.equal(restored.getRun("R1").status, "DONE");
  assert.equal(restored.getTask("T1").lastArtifact.commit, "b".repeat(40));
});

test("Git-required run cannot complete until artifact validation is persisted", async () => {
  const store = new SchedulerStore({ storageArea: fakeStorage() });
  await store.load();
  await store.initializeProject(project(), { maxRetries: 1 });
  await store.setGitSnapshot({ provider: "test-git", defaultBranch: "main", baseSha: "a".repeat(40) });
  await store.createRun({ taskId: "T1", runId: "R1", agentId: "A1", git: gitAssignment("R1") });

  const rejected = await store.markDone("R1");
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, "git_artifact_not_valid");
  assert.equal(store.getTask("T1").status, "ASSIGNED");

  const accepted = await finishWorker(store, "R1");
  assert.equal(accepted.ok, true);
  assert.equal(store.getTask("T1").status, "DONE_BY_WORKER");
  assert.deepEqual(store.runnableTasks().map((task) => task.id), []);
});

test("CHANGES_REQUIRED returns task to READY with structured rework context", async () => {
  const store = new SchedulerStore({ storageArea: fakeStorage() });
  await store.load();
  await store.initializeProject(project(), { maxRetries: 1 });
  await store.setGitSnapshot({ provider: "test-git", defaultBranch: "main", baseSha: "a".repeat(40) });
  await store.createRun({ taskId: "T1", runId: "R1", agentId: "A1", git: gitAssignment("R1") });
  const done = await finishWorker(store, "R1");
  await store.markReviewPending("T1", "REV1", done.task.workerReport);
  await store.markReviewing("T1", "REV1", "A2");
  const changed = await store.markChangesRequired("T1", {
    reviewId: "REV1",
    reviewerAgentId: "A2",
    workerRunId: "R1",
    iteration: 1,
    maxReviewIterations: 3,
    result: { issues: [{ code: "AC_FAIL" }], requiredChanges: ["Fix acceptance criterion"] }
  });
  assert.equal(changed.status, "READY");
  assert.equal(changed.reviewIterations, 1);
  assert.equal(changed.reworkContext.previousCommit, "b".repeat(40));
  assert.deepEqual(changed.reworkContext.requiredChanges, ["Fix acceptance criterion"]);
});

test("max review iterations escalates instead of endless rework", async () => {
  const store = new SchedulerStore({ storageArea: fakeStorage() });
  await store.load();
  await store.initializeProject(project());
  store.state.tasks.T1.status = "REVIEWING";
  const changed = await store.markChangesRequired("T1", {
    reviewId: "REV3",
    reviewerAgentId: "A2",
    workerRunId: "R3",
    iteration: 3,
    maxReviewIterations: 3,
    result: { issues: [{ code: "still_bad" }], requiredChanges: ["Fix it"] }
  });
  assert.equal(changed.status, "NEEDS_USER");
  assert.equal(changed.lastError.reason, "max_review_iterations_exhausted");
});

test("legacy alpha.6 mutating run without Git assignment cannot bypass Git gate", async () => {
  const store = new SchedulerStore({ storageArea: fakeStorage() });
  await store.load(); await store.initializeProject(project(), { maxRetries: 1 });
  await store.createRun({ taskId: "T1", runId: "legacy-R1", agentId: "A1" });
  const rejected = await store.markDone("legacy-R1");
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, "git_artifact_not_valid");
});

test("legacy DONE_UNVERIFIED without canonical artifact upgrades fail-closed", async () => {
  const storage = fakeStorage();
  const store = new SchedulerStore({ storageArea: storage });
  await store.load(); await store.initializeProject(project(), { maxRetries: 1 });
  store.state.tasks.T1.status = "DONE_UNVERIFIED";
  store.state.tasks.T1.lastRunId = "legacy-done";
  store.state.status = "COMPLETED_UNVERIFIED";
  await store.persist();

  const restored = new SchedulerStore({ storageArea: storage });
  await restored.load();
  assert.equal(restored.getTask("T1").status, "NEEDS_USER");
  assert.equal(restored.summary().status, "NEEDS_USER");
});

test("retry budget means initial attempt plus maxRetries", async () => {
  const store = new SchedulerStore({ storageArea: fakeStorage() });
  await store.load(); await store.initializeProject(project(), { maxRetries: 2 });
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const runId = `R${attempt}`;
    await store.createRun({ taskId: "T1", runId, agentId: "A1", git: gitAssignment(runId) });
    const result = await store.markFailure(runId, "error", { retryable: true });
    if (attempt < 3) assert.equal(result.task.status, "READY");
    else assert.equal(result.task.status, "NEEDS_USER");
  }
  assert.equal(store.getTask("T1").attempts, 3);
});
