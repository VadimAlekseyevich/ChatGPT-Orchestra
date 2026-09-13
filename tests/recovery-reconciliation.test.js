const test = require("node:test");
const assert = require("node:assert/strict");

require("../background/git-provider.js");
const { SchedulerStore } = require("../background/scheduler-store.js");
require("../background/scheduler-engine.js");
require("../background/recovery-controller.js");
require("../background/recovery-hooks.js");
const { SchedulerEngine } = require("../background/scheduler-engine.js");

function fakeStorage() {
  const data = {};
  return { async get(key) { return { [key]: data[key] }; }, async set(values) { Object.assign(data, values); } };
}

function project() {
  return {
    projectId: "P1",
    repository: { owner: "acme", repo: "widget" },
    taskGraph: {
      tasks: [{
        id: "T1",
        title: "Change API",
        objective: "Update API safely",
        kind: "code",
        dependencies: [],
        scope: { allow: ["src/**"] },
        acceptanceCriteria: ["API updated"],
        verification: ["npm test"]
      }]
    }
  };
}

test("missing Worker with safe remote progress becomes a fresh READY run seeded from reconciled commit", async () => {
  const base = "a".repeat(40);
  const recovered = "b".repeat(40);
  const storage = fakeStorage();
  const store = new SchedulerStore({ storageArea: storage });
  await store.load();
  await store.initializeProject(project(), { maxWorkers: 3, maxRetries: 2 });
  await store.setGitSnapshot({ provider: "github-rest-v1", defaultBranch: "main", baseSha: base, currentTargetSha: base });
  await store.createRun({
    taskId: "T1",
    runId: "R1",
    agentId: "A1",
    locks: [],
    git: { required: true, provider: "github-rest-v1", branch: "orchestra/P1/T1/R1", targetBranch: "main", baseSha: base, startSha: base }
  });

  const gitProvider = {
    async checkBaseFresh() { return { ok: true, currentTargetSha: base, checkedAt: 10 }; },
    async getBranchHead() { return { ok: true, sha: recovered }; },
    async compare() {
      return {
        ok: true,
        comparison: {
          merge_base_commit: { sha: base },
          behind_by: 0,
          files: [{ filename: "src/api.js" }]
        }
      };
    }
  };
  const registry = {
    getAgent() { return null; },
    async setProtocolContext() {},
    async clearProtocolContext() {},
    listAgents() { return []; }
  };
  const projectStore = { getActiveProject() { return project(); } };
  const engine = new SchedulerEngine({
    store,
    projectStore,
    registry,
    eventBus: { subscribe() { return () => {}; } },
    gitProvider,
    reviewEngine: null,
    sendPrompt: async () => ({ ok: true })
  });

  const result = await engine.reconcileForResume();
  assert.equal(result.ok, true);
  assert.equal(store.getRun("R1").status, "INTERRUPTED");
  const task = store.getTask("T1");
  assert.equal(task.status, "READY");
  assert.equal(task.attempts, 0);
  assert.equal(task.reworkContext.previousCommit, recovered);
  assert.deepEqual(task.reworkContext.previousArtifact.changedFiles, ["src/api.js"]);
});

test("unsafe recovered branch fails closed instead of becoming a new start SHA", async () => {
  const base = "a".repeat(40);
  const recovered = "c".repeat(40);
  const store = new SchedulerStore({ storageArea: fakeStorage() });
  await store.load();
  await store.initializeProject(project(), { maxWorkers: 3, maxRetries: 2 });
  await store.setGitSnapshot({ provider: "github-rest-v1", defaultBranch: "main", baseSha: base, currentTargetSha: base });
  await store.createRun({ taskId: "T1", runId: "R1", agentId: "A1", git: { required: true, branch: "orchestra/P1/T1/R1", targetBranch: "main", baseSha: base, startSha: base } });
  const engine = new SchedulerEngine({
    store,
    projectStore: { getActiveProject() { return project(); } },
    registry: { getAgent() { return null; }, listAgents() { return []; } },
    eventBus: { subscribe() { return () => {}; } },
    gitProvider: {
      async checkBaseFresh() { return { ok: true, currentTargetSha: base }; },
      async getBranchHead() { return { ok: true, sha: recovered }; },
      async compare() { return { ok: true, comparison: { merge_base_commit: { sha: base }, behind_by: 0, files: [{ filename: "secrets.txt" }] } }; }
    },
    sendPrompt: async () => ({ ok: true })
  });
  const result = await engine.reconcileForResume();
  assert.equal(result.ok, false);
  assert.equal(result.issues[0].code, "changed_file_outside_scope");
  assert.equal(store.getRun("R1").status, "ASSIGNED");
});
