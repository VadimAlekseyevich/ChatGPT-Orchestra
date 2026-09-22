const test = require("node:test");
const assert = require("node:assert/strict");

require("../background/git-provider.js");
require("../background/integration-policy.js");
require("../prompts/integration-prompts.js");
const { IntegrationStore } = require("../background/integration-store.js");
const { IntegrationEngine } = require("../background/integration-engine.js");

const BASE = "a".repeat(40);
const T1 = "b".repeat(40);
const T2 = "c".repeat(40);
const HEAD = "d".repeat(40);
const MERGE1 = "e".repeat(40);

function fakeStorage() {
  const data = {};
  return { async get(key) { return { [key]: data[key] }; }, async set(values) { Object.assign(data, values); } };
}

class FakeEventBus {
  constructor() { this.listeners = new Map(); }
  subscribe(route, listener) {
    const list = this.listeners.get(route) || [];
    list.push(listener);
    this.listeners.set(route, list);
    return () => {};
  }
}

function approvedTask(id, commit, branch, changedFiles, lastRunId) {
  return {
    id,
    title: id === "T1" ? "API schema" : "Consumer",
    objective: `Implement ${id}`,
    kind: "code",
    dependencies: id === "T2" ? ["T1"] : [],
    verification: ["npm test"],
    status: "APPROVED",
    lastRunId,
    lastArtifact: { commit, branch, baseSha: BASE, targetBranch: "main", changedFiles }
  };
}

function scheduler(tasks) {
  const state = { status: "READY_FOR_INTEGRATION", decisions: [] };
  const runs = { R1: { runId: "R1", agentId: "A1" }, R2: { runId: "R2", agentId: "A2" } };
  return {
    state,
    summary() { return { status: state.status, projectId: "P1" }; },
    listTasks() { return tasks.map((task) => JSON.parse(JSON.stringify(task))); },
    getRun(runId) { return runs[runId] ? { ...runs[runId] } : null; },
    getGitSnapshot() { return { provider: "test", defaultBranch: "main", baseSha: BASE }; },
    async setStatus(status) { state.status = status; return this.summary(); },
    async logDecision(type, details) { state.decisions.push({ type, details }); }
  };
}

function projects() {
  const project = {
    projectId: "P1",
    status: "READY_FOR_INTEGRATION",
    repository: { url: "https://github.com/acme/widget", owner: "acme", repo: "widget" },
    artifacts: { DISCOVERY: { testCommands: ["npm test"] } }
  };
  return {
    project,
    getActiveProject() { return JSON.parse(JSON.stringify(project)); },
    async setExecutionStatus(projectId, status, details) {
      assert.equal(projectId, "P1");
      project.status = status;
      project.execution = { status, details };
      return this.getActiveProject();
    }
  };
}

function registry() {
  const agents = ["A1", "A2", "A3"].map((agentId, index) => ({ agentId, role: "worker", tabId: 10 + index, status: "IDLE", protocolContext: null, lastSeenAt: 0 }));
  return {
    agents,
    listAgents() { return agents.map((agent) => ({ ...agent, protocolContext: agent.protocolContext ? { ...agent.protocolContext } : null })); },
    getAgent(agentId) { const agent = agents.find((item) => item.agentId === agentId); return agent ? { ...agent, protocolContext: agent.protocolContext ? { ...agent.protocolContext } : null } : null; },
    async setProtocolContext(agentId, context) { const agent = agents.find((item) => item.agentId === agentId); if (!agent) return null; agent.protocolContext = { ...context }; return { ...agent }; },
    async clearProtocolContext(agentId) { const agent = agents.find((item) => item.agentId === agentId); if (agent) agent.protocolContext = null; return agent ? { ...agent } : null; }
  };
}

function provider() {
  return {
    async checkBaseFresh() { return { ok: true, currentTargetSha: BASE }; },
    async getBranchHead(_project, branch) { return { ok: true, branch, sha: HEAD }; },
    async compare(_project, base, head) {
      if (base === BASE && head === HEAD) {
        return { ok: true, comparison: {
          merge_base_commit: { sha: BASE }, ahead_by: 2, behind_by: 0,
          files: [{ filename: "src/a.js" }, { filename: "src/b.js" }]
        } };
      }
      if ((base === T1 || base === T2) && head === HEAD) {
        return { ok: true, comparison: { merge_base_commit: { sha: base }, ahead_by: 1, behind_by: 0, files: [] } };
      }
      throw new Error(`unexpected compare ${base}...${head}`);
    },
    async request(path) {
      if (path.endsWith(`/git/commits/${HEAD}`)) return { ok: true, data: { sha: HEAD, parents: [{ sha: MERGE1 }, { sha: T2 }] } };
      if (path.endsWith(`/git/commits/${MERGE1}`)) return { ok: true, data: { sha: MERGE1, parents: [{ sha: BASE }, { sha: T1 }] } };
      return { ok: false, reason: "not_found" };
    }
  };
}

function completion(run) {
  return {
    event: {
      v: 1, event: "DONE", projectId: "P1", taskId: "integration", runId: run.runId, agentId: run.agentId,
      eventId: `${run.runId}-done`, sequence: 1,
      payload: { integration: {
        branch: run.branch, commit: HEAD, baseSha: BASE, targetBranch: "main",
        mergedTaskIds: ["T1", "T2"], changedFiles: ["src/a.js", "src/b.js"],
        checks: [{ command: "npm test", status: "PASS", evidence: "all integration tests passed" }],
        summary: "integrated"
      } }
    }
  };
}

async function setup({ sharedConflict = false } = {}) {
  const tasks = [
    approvedTask("T1", T1, "orchestra/P1/T1/R1", sharedConflict ? ["src/shared.js"] : ["src/a.js"], "R1"),
    approvedTask("T2", T2, "orchestra/P1/T2/R2", sharedConflict ? ["src/shared.js"] : ["src/b.js"], "R2")
  ];
  const store = new IntegrationStore({ storageArea: fakeStorage() });
  const schedulerStore = scheduler(tasks);
  const projectStore = projects();
  const agentRegistry = registry();
  const prompts = [];
  const engine = new IntegrationEngine({
    store, schedulerStore, projectStore, registry: agentRegistry, eventBus: new FakeEventBus(), gitProvider: provider(),
    idFactory: () => "I1",
    sendPrompt: async (agentId, prompt) => { prompts.push({ agentId, prompt }); return { ok: true }; }
  });
  await engine.init();
  return { engine, store, schedulerStore, projectStore, agentRegistry, prompts };
}

test("allocates a dynamic Integrator and verifies remote merge ancestry/order before completion", async () => {
  const { engine, store, schedulerStore, projectStore, prompts } = await setup();
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
      summary: "semantic incompatibility"
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
    eventId: `${run.runId}-semantic`, sequence: 1,
    payload: {
      conflictType: "semantic",
      mergedTaskIds: ["T1", "T2"],
      responsibleTaskIds: ["T1", "T2"],
      files: [],
      failedChecks: [{ command: "npm test", evidence: "cross-module assertion failed" }],
      summary: "semantic incompatibility"
    }
  } });
  assert.equal(store.currentRun().status, "REPAIRING");
  assert.deepEqual(store.listRepairs()[0].responsibleTaskIds, ["T1", "T2"]);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1].prompt, /For semantic conflict: make the smallest compatibility repair/);
});


test("verified IntegrationStore reconciles Scheduler and Project after a crash boundary", async () => {
  const { engine, store, schedulerStore, projectStore } = await setup();
  const run = store.currentRun();
  const result = {
    branch: run.branch,
    commit: HEAD,
    baseSha: BASE,
    targetBranch: "main",
    mergedTaskIds: ["T1", "T2"],
    changedFiles: ["src/a.js", "src/b.js"],
    checks: [],
    summary: "already validated before crash"
  };

  await store.complete(run.runId, result);
  assert.equal(store.summary().status, "INTEGRATION_VERIFIED");
  assert.equal(schedulerStore.state.status, "INTEGRATING");
  assert.equal(projectStore.project.status, "INTEGRATING");

  const reconciled = await engine.reconcileVerifiedState({ reason: "test_crash_boundary" });
  assert.equal(reconciled.ok, true);
  assert.equal(reconciled.reconciled, true);
  assert.equal(schedulerStore.state.status, "INTEGRATION_VERIFIED");
  assert.equal(projectStore.project.status, "INTEGRATION_VERIFIED");
});
