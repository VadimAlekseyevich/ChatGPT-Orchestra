const test = require("node:test");
const assert = require("node:assert/strict");

require("../prompts/integration-prompts.js");
require("../prompts/worker-prompts.js");
const { IntegrationStore } = require("../background/integration-store.js");
const { IntegrationEngine } = require("../background/integration-engine.js");

function artifact(taskId, commit, changedFiles) {
  return {
    taskId,
    branch: `orchestra/P1/${taskId}/R-${taskId}`,
    commit,
    baseSha: "a".repeat(40),
    targetBranch: "main",
    changedFiles
  };
}

function task(id, dependencies, gitArtifact, category = "feature") {
  return {
    id,
    title: id,
    objective: `${id} objective`,
    status: "APPROVED",
    dependencies,
    acceptanceCriteria: [`${id} accepted`],
    verification: ["npm test"],
    category,
    lastArtifact: gitArtifact,
    lastReview: { status: "APPROVED", summary: "ok" }
  };
}

class StorageArea {
  constructor() { this.data = {}; }
  async get(key) { return { [key]: this.data[key] }; }
  async set(values) { Object.assign(this.data, JSON.parse(JSON.stringify(values))); }
}

class FakeGitProvider {
  constructor() {
    this.targetSha = "a".repeat(40);
    this.branches = new Map();
    this.compares = new Map();
  }
  async getRef(repo, branch) {
    const sha = branch === "main" ? this.targetSha : this.branches.get(branch);
    return sha ? { ok: true, sha } : { ok: false, reason: "ref_missing" };
  }
  async compare(repo, base, head) {
    return this.compares.get(`${base}...${head}`) || { ok: false, reason: "compare_missing" };
  }
  setBranch(branch, sha) { this.branches.set(branch, sha); }
  setCompare(base, head, value) { this.compares.set(`${base}...${head}`, value); }
}

async function setup({ sharedConflict = false } = {}) {
  const a1 = artifact("T1", "b".repeat(40), [sharedConflict ? "src/shared.js" : "src/base.js"]);
  const a2 = artifact("T2", "c".repeat(40), [sharedConflict ? "src/shared.js" : "src/feature.js"]);
  const tasks = [
    task("T1", [], a1, "foundation"),
    task("T2", ["T1"], a2, "feature")
  ];
  const schedulerStore = {
    state: { status: "READY_FOR_INTEGRATION" },
    listTasks: () => tasks.map((entry) => JSON.parse(JSON.stringify(entry))),
    getTask: (id) => JSON.parse(JSON.stringify(tasks.find((entry) => entry.id === id) || null)),
    async setExecutionStatus(status) { this.state.status = status; },
    summary() { return { status: this.state.status }; }
  };
  const projectStore = {
    project: {
      projectId: "P1",
      status: "READY_FOR_INTEGRATION",
      repository: { url: "https://github.com/acme/widget", owner: "acme", repo: "widget" },
      execution: { git: { targetBranch: "main", baseSha: "a".repeat(40) } },
      artifacts: { DISCOVERY: { commands: { test: ["npm test"] } } }
    },
    getActiveProject() { return JSON.parse(JSON.stringify(this.project)); },
    async setStatus(status) { this.project.status = status; }
  };
  const agents = [
    { agentId: "A1", role: "worker", status: "IDLE" },
    { agentId: "A2", role: "worker", status: "IDLE" },
    { agentId: "A3", role: "worker", status: "IDLE" }
  ];
  const registry = {
    listAgents: () => agents.map((entry) => ({ ...entry })),
    isAgentConnected: () => true,
    async setProtocolContext() {},
    async clearProtocolContext() {}
  };
  const storageArea = new StorageArea();
  const store = new IntegrationStore({ storageArea });
  const provider = new FakeGitProvider();
  const prompts = [];
  const engine = new IntegrationEngine({
    projectStore,
    schedulerStore,
    registry,
    store,
    gitProvider: provider,
    sendPrompt: async (agentId, prompt) => { prompts.push({ agentId, prompt }); return { ok: true }; },
    now: (() => { let n = 1789315359944; return () => ++n; })()
  });
  await engine.init();
  const started = await engine.maybeStart();
  assert.equal(started.ok, true);
  const run = store.currentRun();
  const head = "d".repeat(40);
  provider.setBranch(run.branch, head);
  provider.setCompare(run.baseSha, head, {
    ok: true,
    status: "ahead",
    aheadBy: 4,
    behindBy: 0,
    mergeBaseSha: run.baseSha,
    files: [...new Set(run.artifacts.flatMap((entry) => entry.changedFiles))],
    commits: [
      { sha: run.artifacts[0].commit, parents: [run.baseSha] },
      { sha: "1".repeat(40), parents: [run.artifacts[0].commit, run.baseSha], message: "merge T1" },
      { sha: run.artifacts[1].commit, parents: [run.baseSha] },
      { sha: head, parents: ["1".repeat(40), run.artifacts[1].commit], message: "merge T2" }
    ]
  });
  provider.setCompare(run.artifacts[0].commit, head, { ok: true, status: "ahead", aheadBy: 1, behindBy: 0, mergeBaseSha: run.artifacts[0].commit, files: [] });
  provider.setCompare(run.artifacts[1].commit, head, { ok: true, status: "ahead", aheadBy: 1, behindBy: 0, mergeBaseSha: run.artifacts[1].commit, files: [] });
  return { engine, store, provider, prompts, schedulerStore, projectStore, tasks };
}

function completion(run) {
  return {
    event: {
      v: 1,
      event: "DONE",
      projectId: "P1",
      taskId: "integration",
      runId: run.runId,
      agentId: run.agentId,
      eventId: `${run.runId}-done`,
      sequence: 1,
      payload: {
        integration: {
          branch: run.branch,
          headCommit: "d".repeat(40),
          baseSha: run.baseSha,
          targetBranch: run.targetBranch,
          mergedTaskIds: [...run.mergeTaskIds],
          changedFiles: [...new Set(run.artifacts.flatMap((entry) => entry.changedFiles))],
          checks: run.verificationCommands.map((command) => ({ command, status: "PASS", evidence: "ok" }))
        }
      }
    }
  };
}

test("allocates a dynamic Integrator and verifies remote merge ancestry/order before completion", async () => {
  const { engine, store, prompts, schedulerStore, projectStore } = await setup();
  const run = store.currentRun();
  assert.equal(run.agentId, "A3");
  assert.equal(run.status, "RUNNING");
  assert.equal(prompts.length, 1);
  assert.match(prompts[0].prompt, /Do not modify or push the target branch/);
  assert.deepEqual(run.mergeTaskIds, ["T1", "T2"]);

  await engine.handleCompletion(completion(run));
  assert.equal(store.summary().status, "INTEGRATION_VERIFIED");
  assert.equal(schedulerStore.state.status, "INTEGRATION_VERIFIED");
  assert.equal(projectStore.project.status, "INTEGRATION_VERIFIED");
  assert.deepEqual(store.summary().summary.remoteValidation.firstParentMergeOrder, ["T1", "T2"]);
});

test("text merge conflict creates a persisted repair task and a bounded second Integrator turn", async () => {
  const { engine, store, prompts } = await setup({ sharedConflict: true });
  const run = store.currentRun();
  await engine.handleIntegrationEvent({ event: {
    v: 1, event: "CONFLICT", projectId: "P1", taskId: "integration", runId: run.runId, agentId: run.agentId,
    eventId: `${run.runId}-conflict-1`, sequence: 1,
    payload: {
      conflictType: "text",
      currentTaskId: "T2",
      mergedTaskIds: ["T1"],
      responsibleTaskIds: [],
      files: ["src/shared.js"],
      failedChecks: [],
      summary: "content conflict"
    }
  } });
  assert.equal(store.currentRun().status, "REPAIRING");
  assert.equal(store.listRepairs().length, 1);
  assert.deepEqual(store.listRepairs()[0].responsibleTaskIds, ["T1", "T2"]);
  assert.equal(store.listRepairs()[0].nextSequence, 2);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1].prompt, /PORTABLE REPAIR PACKET/);
  assert.match(prompts[1].prompt, /"attempt": 1/);
  assert.match(prompts[1].prompt, /Use sequence=2/);
});

test("semantic conflict without explicit upstream attribution fails closed", async () => {
  const { engine, store, schedulerStore, projectStore } = await setup();
  const run = store.currentRun();
  await engine.handleIntegrationEvent({ event: {
    v: 1, event: "CONFLICT", projectId: "P1", taskId: "integration", runId: run.runId, agentId: run.agentId,
    eventId: `${run.runId}-semantic`, sequence: 1,
    payload: {
      conflictType: "semantic",
      currentTaskId: null,
      mergedTaskIds: ["T1", "T2"],
      responsibleTaskIds: [],
      files: [],
      failedChecks: [{ command: "npm test", evidence: "cross-module assertion failed" }],
      summary: "semantic mismatch"
    }
  } });
  assert.equal(store.summary().status, "NEEDS_USER");
  assert.equal(schedulerStore.state.status, "NEEDS_USER");
  assert.equal(projectStore.project.status, "NEEDS_USER");
});

test("semantic conflict with explicit responsible tasks enters repair loop", async () => {
  const { engine, store, prompts } = await setup();
  const run = store.currentRun();
  await engine.handleIntegrationEvent({ event: {
    v: 1, event: "CONFLICT", projectId: "P1", taskId: "integration", runId: run.runId, agentId: run.agentId,
    eventId: `${run.runId}-semantic-2`, sequence: 1,
    payload: {
      conflictType: "semantic",
      currentTaskId: null,
      mergedTaskIds: ["T1", "T2"],
      responsibleTaskIds: ["T1", "T2"],
      files: ["src/base.js", "src/feature.js"],
      failedChecks: [{ command: "npm test", evidence: "cross-module assertion failed" }],
      summary: "semantic mismatch"
    }
  } });
  assert.equal(store.currentRun().status, "REPAIRING");
  assert.equal(store.listRepairs().length, 1);
  assert.equal(prompts.length, 2);
});
