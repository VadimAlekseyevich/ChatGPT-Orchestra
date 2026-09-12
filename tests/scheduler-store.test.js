const test = require("node:test");
const assert = require("node:assert/strict");
const { SchedulerStore } = require("../background/scheduler-store.js");

function fakeStorage() {
  const data = {};
  return {
    data,
    async get(key) { return { [key]: data[key] }; },
    async set(values) { Object.assign(data, values); }
  };
}

function project() {
  return {
    projectId: "P1",
    taskGraph: {
      tasks: [
        { id: "T1", title: "One", dependencies: [], scope: { allow: ["src/a/**"] }, acceptanceCriteria: ["done"], verification: ["npm test"], priority: 10, risk: "low", estimatedComplexity: "S" },
        { id: "T2", title: "Two", dependencies: ["T1"], scope: { allow: ["src/b/**"] }, acceptanceCriteria: ["done"], verification: ["npm test"], priority: 5, risk: "low", estimatedComplexity: "S" }
      ]
    }
  };
}

test("persists task/run transitions and unlocks dependencies only after DONE_UNVERIFIED", async () => {
  let now = 100;
  const storage = fakeStorage();
  const store = new SchedulerStore({ storageArea: storage, clock: () => now });
  await store.load();
  await store.initializeProject(project(), { maxWorkers: 3, maxRetries: 2 });
  assert.deepEqual(store.runnableTasks().map((task) => task.id), ["T1"]);

  await store.createRun({ taskId: "T1", runId: "R1", agentId: "A1" });
  assert.equal(store.getTask("T1").status, "ASSIGNED");
  now += 10;
  await store.markRunning("R1");
  assert.equal(store.getTask("T1").status, "RUNNING");
  now += 10;
  await store.markDone("R1");
  assert.equal(store.getTask("T1").status, "DONE_UNVERIFIED");
  assert.deepEqual(store.runnableTasks().map((task) => task.id), ["T2"]);

  const restored = new SchedulerStore({ storageArea: storage });
  await restored.load();
  assert.equal(restored.getTask("T1").status, "DONE_UNVERIFIED");
  assert.equal(restored.getRun("R1").status, "DONE");
});

test("Git-required run cannot complete until artifact validation is persisted", async () => {
  const store = new SchedulerStore({ storageArea: fakeStorage() });
  await store.load();
  await store.initializeProject(project(), { maxRetries: 1 });
  await store.setGitSnapshot({ provider: "test-git", defaultBranch: "main", baseSha: "a".repeat(40) });
  await store.createRun({
    taskId: "T1",
    runId: "R1",
    agentId: "A1",
    git: {
      required: true,
      provider: "test-git",
      branch: "orchestra/P1/T1/R1",
      targetBranch: "main",
      baseSha: "a".repeat(40)
    }
  });

  const rejected = await store.markDone("R1");
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, "git_artifact_not_valid");
  assert.equal(store.getTask("T1").status, "ASSIGNED");
  assert.deepEqual(store.runnableTasks().map((task) => task.id), []);

  await store.recordArtifactValidation("R1", {
    ok: true,
    artifact: {
      provider: "test-git",
      branch: "orchestra/P1/T1/R1",
      commit: "b".repeat(40),
      baseSha: "a".repeat(40),
      targetBranch: "main",
      changedFiles: ["src/a/file.js"]
    }
  });
  const accepted = await store.markDone("R1");
  assert.equal(accepted.ok, true);
  assert.equal(store.getTask("T1").status, "DONE_UNVERIFIED");
  assert.equal(store.getTask("T1").lastArtifact.commit, "b".repeat(40));
  assert.deepEqual(store.runnableTasks().map((task) => task.id), ["T2"]);
});

test("retry budget means initial attempt plus maxRetries", async () => {
  const store = new SchedulerStore({ storageArea: fakeStorage() });
  await store.load();
  await store.initializeProject(project(), { maxRetries: 2 });

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const runId = `R${attempt}`;
    await store.createRun({ taskId: "T1", runId, agentId: "A1" });
    const result = await store.markFailure(runId, "error", { retryable: true });
    if (attempt < 3) assert.equal(result.task.status, "READY");
    else assert.equal(result.task.status, "NEEDS_USER");
  }
  assert.equal(store.getTask("T1").attempts, 3);
});
