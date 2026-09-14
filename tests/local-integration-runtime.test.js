"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { LocalIntegrationCoordinator, localIntegrationVerificationPlan } = require("../apps/desktop/main/local-integration-coordinator.js");
const { createLocalIntegrationEngine } = require("../apps/desktop/main/local-integration-engine.js");

const BASE = "a".repeat(40);
const C1 = "b".repeat(40);
const C2 = "c".repeat(40);
const INTEGRATED = "d".repeat(40);

function approvedTask(id, commit, dependencies = []) {
  return {
    id,
    status: "APPROVED",
    dependencies,
    definition: {
      id,
      kind: "code",
      localVerification: [{ command: "node", args: ["--version"], label: "node-version" }]
    },
    lastArtifact: { branch: `orchestra/P1/${id}/R-${id}`, commit, changedFiles: [`src/${id}.js`] }
  };
}

function runSpec() {
  return {
    projectId: "P1",
    runId: "I1",
    branch: "orchestra/P1/integration/I1",
    baseSha: BASE,
    targetBranch: "main",
    taskOrder: ["T1", "T2"],
    mergeTaskIds: ["T1", "T2"],
    artifacts: [
      { taskId: "T1", commit: C1, branch: "orchestra/P1/T1/R-T1", changedFiles: ["src/T1.js"] },
      { taskId: "T2", commit: C2, branch: "orchestra/P1/T2/R-T2", changedFiles: ["src/T2.js"] }
    ],
    verificationCommands: ["legacy text only"]
  };
}

test("local integration verification plan deduplicates structured argv commands", () => {
  const plan = localIntegrationVerificationPlan([approvedTask("T1", C1), approvedTask("T2", C2)]);
  assert.equal(plan.ok, true);
  assert.equal(plan.commands.length, 1);
  assert.deepEqual(plan.commands[0].args, ["--version"]);
});

test("local coordinator merges approved commits in order and verifies the integrated worktree", async () => {
  const calls = [];
  const repositoryService = {
    async createIntegrationWorkspace(payload) { calls.push(["create", payload]); return { ok: true, workspace: { workspaceId: "integration:I1" } }; },
    async mergeTaskArtifact(payload) { calls.push(["merge", payload]); return { ok: true, merge: { ok: true, head: payload.taskCommit === C1 ? "m1" : INTEGRATED, alreadyIntegrated: false } }; },
    async verifyWorkspace(payload) { calls.push(["verify", payload]); return { ok: true, verification: { ok: true, status: "passed", stdout: "v22", stderr: "" } }; },
    async workspaceArtifact(payload) { calls.push(["artifact", payload]); return { ok: true, artifact: { ok: true, workspaceId: "integration:I1", branch: "orchestra/P1/integration/I1", head: INTEGRATED, startSha: BASE, clean: true, changedFiles: ["src/T1.js", "src/T2.js"] } }; }
  };
  const coordinator = new LocalIntegrationCoordinator({ repositoryService, clock: () => 123 });
  const result = await coordinator.integrate({
    project: { projectId: "P1", repositoryRuntime: { repositoryId: "repo-1" } },
    tasks: [approvedTask("T1", C1), approvedTask("T2", C2)],
    runSpec: runSpec()
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.result.mergedTaskIds, ["T1", "T2"]);
  assert.equal(result.result.commit, INTEGRATED);
  assert.equal(result.result.targetBranchUnmodified, true);
  assert.deepEqual(calls.filter((item) => item[0] === "merge").map((item) => item[1].taskCommit), [C1, C2]);
  assert.equal(calls.filter((item) => item[0] === "verify").length, 1);
  assert.deepEqual(calls.find((item) => item[0] === "verify")[1].args, ["--version"]);
});

test("local coordinator returns structured conflict progress without running verification", async () => {
  const calls = [];
  const repositoryService = {
    async createIntegrationWorkspace() { return { ok: true, workspace: { workspaceId: "integration:I1" } }; },
    async mergeTaskArtifact(payload) {
      calls.push(["merge", payload.taskCommit]);
      if (payload.taskCommit === C2) return { ok: false, merge: { ok: false, reason: "git_merge_conflict", files: ["src/shared.js"] } };
      return { ok: true, merge: { ok: true, head: "m1" } };
    },
    async verifyWorkspace() { calls.push(["verify"]); return { ok: true }; }
  };
  const coordinator = new LocalIntegrationCoordinator({ repositoryService });
  const result = await coordinator.integrate({
    project: { projectId: "P1", repositoryRuntime: { repositoryId: "repo-1" } },
    tasks: [approvedTask("T1", C1), approvedTask("T2", C2)],
    runSpec: runSpec()
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "local_integration_merge_conflict");
  assert.deepEqual(result.mergedTaskIds, ["T1"]);
  assert.equal(result.currentTaskId, "T2");
  assert.deepEqual(result.files, ["src/shared.js"]);
  assert.equal(calls.some((item) => item[0] === "verify"), false);
});

function fakeStore() {
  const state = { run: null, status: "IDLE", completed: null, abandoned: [] };
  return {
    state,
    summary() { return { projectId: "P1", status: state.status, settings: { targetPolicy: "integration_branch_only" } }; },
    listRuns() { return state.abandoned.map((runId) => ({ runId, status: "ABANDONED" })); },
    async createRun(spec) { state.run = { ...spec, status: "PENDING", agentId: null }; state.status = "PENDING"; return { ok: true, run: { ...state.run } }; },
    currentRun() { return state.run ? { ...state.run } : null; },
    async markRunning(runId) { assert.equal(runId, state.run.runId); state.run.status = "RUNNING"; state.status = "INTEGRATING"; return { ...state.run }; },
    async complete(runId, result) { assert.equal(runId, state.run.runId); state.run.status = "VERIFIED"; state.run.result = result; state.completed = result; state.status = "INTEGRATION_VERIFIED"; return { ...state.run }; },
    async abandon(runId, reason) { state.abandoned.push(runId); state.run.status = "ABANDONED"; state.run.failureReason = reason; state.run = null; state.status = "PENDING"; return { runId, status: "ABANDONED" }; },
    async fail(runId, reason, details) { state.status = "NEEDS_USER"; state.failed = { runId, reason, details }; return state.run; }
  };
}

class FakeBaseIntegrationEngine {
  constructor(options = {}) { Object.assign(this, options); this.baseStarts = 0; }
  async ensureTargetFresh() { return { ok: true }; }
  buildRunSpec() { return { ok: true, spec: runSpec() }; }
  async startNewRun() { this.baseStarts += 1; return { ok: true, remote: true }; }
  async escalate(reason, details) { await this.store.fail(this.store.currentRun()?.runId || null, reason, details); await this.schedulerStore.setStatus("NEEDS_USER"); return { ok: false, reason }; }
}

function engineFixture(localResult) {
  const store = fakeStore();
  const schedulerStatuses = [];
  const decisions = [];
  const projectStatuses = [];
  const LocalEngine = createLocalIntegrationEngine(FakeBaseIntegrationEngine);
  const engine = new LocalEngine({
    store,
    schedulerStore: {
      async setStatus(status) { schedulerStatuses.push(status); },
      async logDecision(type, details) { decisions.push({ type, details }); }
    },
    projectStore: { async setExecutionStatus(projectId, status, details) { projectStatuses.push({ projectId, status, details }); } },
    localIntegrationCoordinator: { async integrate() { return localResult; } }
  });
  return { engine, store, schedulerStatuses, decisions, projectStatuses };
}

test("local integration success completes IntegrationStore without creating an Integrator agent run", async () => {
  const localResult = {
    ok: true,
    workspaceId: "integration:I1",
    merges: [{}, {}],
    result: { branch: "orchestra/P1/integration/I1", commit: INTEGRATED, baseSha: BASE, targetBranch: "main", mergedTaskIds: ["T1", "T2"], changedFiles: [], checks: [], targetBranchUnmodified: true }
  };
  const { engine, store, schedulerStatuses, decisions } = engineFixture(localResult);
  const result = await engine.startNewRun({ projectId: "P1", repositoryRuntime: { repositoryId: "repo-1" } }, [approvedTask("T1", C1), approvedTask("T2", C2)]);
  assert.equal(result.ok, true);
  assert.equal(result.local, true);
  assert.equal(engine.baseStarts, 0);
  assert.equal(store.state.status, "INTEGRATION_VERIFIED");
  assert.equal(store.state.completed.commit, INTEGRATED);
  assert.equal(schedulerStatuses.at(-1), "INTEGRATION_VERIFIED");
  assert.ok(decisions.some((item) => item.type === "integration_verified_local"));
});

test("local merge conflict abandons the local attempt and falls back to existing AI Integrator path", async () => {
  const { engine, store, schedulerStatuses, decisions } = engineFixture({ ok: false, reason: "local_integration_merge_conflict", currentTaskId: "T2", mergedTaskIds: ["T1"], files: ["src/shared.js"] });
  const result = await engine.startNewRun({ projectId: "P1", repositoryRuntime: { repositoryId: "repo-1" } }, [approvedTask("T1", C1), approvedTask("T2", C2)]);
  assert.equal(result.ok, true);
  assert.equal(result.remote, true);
  assert.equal(engine.baseStarts, 1);
  assert.deepEqual(store.state.abandoned, ["I1"]);
  assert.ok(schedulerStatuses.includes("READY_FOR_INTEGRATION"));
  assert.ok(decisions.some((item) => item.type === "local_integration_fallback"));
});

test("local trust/plan failures stop integration fail-closed instead of falling back", async () => {
  const { engine, store } = engineFixture({ ok: false, reason: "local_integration_repository_execution_not_trusted" });
  const result = await engine.startNewRun({ projectId: "P1", repositoryRuntime: { repositoryId: "repo-1" } }, [approvedTask("T1", C1)]);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "local_integration_repository_execution_not_trusted");
  assert.equal(engine.baseStarts, 0);
  assert.equal(store.state.status, "NEEDS_USER");
});
