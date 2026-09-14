"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { LocalIntegrationCoordinator } = require("../apps/desktop/main/local-integration-coordinator.js");
const { createLocalIntegrationEngine } = require("../apps/desktop/main/local-integration-engine.js");

const BASE = "a".repeat(40);
const C1 = "b".repeat(40);
const C2 = "c".repeat(40);
const HEAD = "d".repeat(40);

function task(id, commit) {
  return {
    id,
    status: "APPROVED",
    definition: { id, kind: "code", localVerification: [{ command: "node", args: ["--version"] }] },
    lastArtifact: { branch: `orchestra/P1/${id}/R-${id}`, commit, changedFiles: [`src/${id}.js`] }
  };
}

function run() {
  return {
    projectId: "P1",
    runId: "I1",
    status: "RUNNING",
    agentId: null,
    branch: "orchestra/P1/integration/I1",
    baseSha: BASE,
    targetBranch: "main",
    taskOrder: ["T1", "T2"],
    mergeTaskIds: ["T1", "T2"],
    artifacts: [
      { taskId: "T1", commit: C1, branch: "orchestra/P1/T1/R-T1", changedFiles: ["src/T1.js"] },
      { taskId: "T2", commit: C2, branch: "orchestra/P1/T2/R-T2", changedFiles: ["src/T2.js"] }
    ],
    verificationCommands: []
  };
}

const project = { projectId: "P1", repositoryRuntime: { repositoryId: "repo-1" } };
const tasks = [task("T1", C1), task("T2", C2)];

test("coordinator reuses an existing integration worktree and skips commits already merged before crash", async () => {
  const calls = [];
  const repositoryService = {
    async createIntegrationWorkspace() { throw new Error("git_workspace_already_exists"); },
    async workspaceStatus(payload) { calls.push(["status", payload]); return { ok: true, status: { ok: true, workspaceId: "integration:I1", clean: true, head: "m1" } }; },
    async mergeTaskArtifact(payload) {
      calls.push(["merge", payload.taskCommit]);
      if (payload.taskCommit === C1) return { ok: true, merge: { ok: true, alreadyIntegrated: true, head: "m1" } };
      return { ok: true, merge: { ok: true, alreadyIntegrated: false, head: HEAD } };
    },
    async verifyWorkspace(payload) { calls.push(["verify", payload]); return { ok: true, verification: { ok: true, status: "passed", stdout: "", stderr: "" } }; },
    async workspaceArtifact() { return { ok: true, artifact: { branch: "orchestra/P1/integration/I1", head: HEAD, clean: true, changedFiles: ["src/T1.js", "src/T2.js"] } }; }
  };
  const coordinator = new LocalIntegrationCoordinator({ repositoryService, clock: () => 99 });
  const result = await coordinator.integrate({ project, tasks, runSpec: run() });
  assert.equal(result.ok, true);
  assert.equal(result.recovered, true);
  assert.equal(result.result.recoveredWorkspace, true);
  assert.equal(result.merges[0].alreadyIntegrated, true);
  assert.equal(result.merges[1].alreadyIntegrated, false);
  assert.deepEqual(calls.filter((item) => item[0] === "merge").map((item) => item[1]), [C1, C2]);
});

class FakeBase {
  constructor(options = {}) { Object.assign(this, options); this.baseRestores = 0; }
  async ensureTargetFresh() { return { ok: true }; }
  async restoreActiveRun() { this.baseRestores += 1; return { ok: true, base: true }; }
  async startNewRun() { throw new Error("must_not_start_new_run_during_local_recovery"); }
  async escalate(reason, details) { await this.store.fail(this.store.currentRun()?.runId || null, reason, details); return { ok: false, reason }; }
}

test("desktop integration recovery completes the same runId instead of treating it as a lost Integrator agent", async () => {
  const state = { run: run(), status: "INTEGRATING", completed: null };
  const decisions = [];
  const schedulerStatuses = [];
  const LocalEngine = createLocalIntegrationEngine(FakeBase);
  const engine = new LocalEngine({
    store: {
      currentRun: () => state.run ? { ...state.run } : null,
      summary: () => ({ projectId: "P1", status: state.status, settings: { targetPolicy: "integration_branch_only" } }),
      async complete(runId, result) { assert.equal(runId, "I1"); state.completed = result; state.run = { ...state.run, status: "VERIFIED", result }; state.status = "INTEGRATION_VERIFIED"; return { ...state.run }; },
      async fail(runId, reason, details) { state.status = "NEEDS_USER"; state.failed = { runId, reason, details }; }
    },
    projectStore: {
      getActiveProject: () => project,
      async setExecutionStatus() {}
    },
    schedulerStore: {
      listTasks: () => tasks.map((item) => ({ ...item })),
      async setStatus(status) { schedulerStatuses.push(status); },
      async logDecision(type, details) { decisions.push({ type, details }); }
    },
    localIntegrationCoordinator: {
      async integrate({ runSpec }) {
        assert.equal(runSpec.runId, "I1");
        return {
          ok: true,
          recovered: true,
          workspaceId: "integration:I1",
          merges: [{ alreadyIntegrated: true }, { alreadyIntegrated: false }],
          result: { branch: runSpec.branch, commit: HEAD, baseSha: BASE, targetBranch: "main", mergedTaskIds: ["T1", "T2"], changedFiles: [], checks: [], recoveredWorkspace: true }
        };
      }
    }
  });

  const result = await engine.restoreActiveRun();
  assert.equal(result.ok, true);
  assert.equal(result.recovered, true);
  assert.equal(engine.baseRestores, 0);
  assert.equal(state.status, "INTEGRATION_VERIFIED");
  assert.equal(state.completed.localValidation.recovered, true);
  assert.equal(schedulerStatuses.at(-1), "INTEGRATION_VERIFIED");
  assert.ok(decisions.some((item) => item.type === "local_integration_recovery_started"));
  assert.ok(decisions.some((item) => item.type === "integration_recovered_local"));
});
