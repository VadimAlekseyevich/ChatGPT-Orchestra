const test = require("node:test");
const assert = require("node:assert/strict");

const { ObservabilityService } = require("../background/observability-service.js");

function fixture() {
  const now = 1_000_000;
  const tasks = {
    T1: { id: "T1", title: "Foundation", objective: "base", kind: "code", status: "APPROVED", dependencies: [], scope: { allow: ["src/core/**"] }, acceptanceCriteria: ["works"], verification: ["npm test"], priority: 10, risk: "medium", estimatedComplexity: "M", attempts: 1, activeRunId: null, lastRunId: "R1", lastArtifact: { commit: "a".repeat(40), branch: "orchestra/P/T1/R1" }, reviewIterations: 1, updatedAt: now - 100 },
    T2: { id: "T2", title: "Consumer", objective: "consume", kind: "code", status: "NEEDS_USER", dependencies: ["T1"], scope: { allow: ["src/consumer/**"] }, acceptanceCriteria: ["works"], verification: ["npm test"], priority: 1, risk: "high", estimatedComplexity: "S", attempts: 2, activeRunId: null, lastRunId: "R2", lastError: { reason: "blocked", at: now - 20 }, reviewIterations: 0, updatedAt: now - 20 }
  };
  const runs = {
    R1: { runId: "R1", taskId: "T1", agentId: "A1", status: "DONE", startedAt: now - 500, finishedAt: now - 300, lastEventAt: now - 300, git: { required: true, branch: "orchestra/P/T1/R1", baseSha: "b".repeat(40), artifactStatus: "VALID", artifact: tasks.T1.lastArtifact } },
    R2: { runId: "R2", taskId: "T2", agentId: "A2", status: "NEEDS_USER", startedAt: now - 200, finishedAt: now - 20, lastEventAt: now - 20, failureReason: "blocked" }
  };
  const schedulerStore = {
    summary: () => ({ projectId: "P1", status: "NEEDS_USER", taskCount: 2, counts: { APPROVED: 1, NEEDS_USER: 1 }, activeRuns: 0, git: { defaultBranch: "main", baseSha: "b".repeat(40) }, updatedAt: now }),
    listTasks: () => Object.values(tasks),
    getTask: (id) => tasks[id] || null,
    listRuns: () => Object.values(runs),
    getRun: (id) => runs[id] || null,
    recentDecisions: () => [{ at: now - 10, type: "blocked", details: { taskId: "T2", tabId: 99 } }]
  };
  const reviewStore = {
    list: () => [{ reviewId: "V1", taskId: "T1", workerRunId: "R1", authorAgentId: "A1", reviewerAgentId: "A2", status: "APPROVED", result: { summary: "ok", sessionId: "secret-session" }, completedAt: now - 100, updatedAt: now - 100 }],
    summary: () => ({ projectId: "P1", total: 1, active: 0, pending: 0, updatedAt: now - 100 })
  };
  const integrationStore = {
    summary: () => ({ projectId: "P1", status: "IDLE", currentRunId: null, currentRun: null, updatedAt: now }),
    listRuns: () => [],
    listRepairs: () => []
  };
  const projectStore = { getActiveProject: () => ({ projectId: "P1", status: "NEEDS_USER", stage: "EXECUTION_BLOCKED", initialGoal: "goal", repository: { url: "https://github.com/a/b", fullName: "a/b" }, updatedAt: now, execution: { tabId: 55 } }) };
  const registry = {
    listAgents: () => [
      { agentId: "lead", role: "lead", label: "Lead", status: "IDLE", tabId: 42, sessionId: "42", lastSeenAt: now, protocolContext: { projectId: "P1", taskId: "planning", runId: "x" } },
      { agentId: "A2", role: "worker", label: "Worker", status: "OFFLINE", tabId: 43, sessionId: "43", lastSeenAt: now - 500 }
    ],
    isAgentConnected: (agent) => agent.status !== "OFFLINE"
  };
  const eventBus = { recent: () => ({ events: [{ receivedAt: now, tabId: 42, runtimeSource: { sessionId: "42" }, source: { runtime: { sessionId: "42" } }, event: { projectId: "P1", taskId: "T2", event: "ERROR", payload: { reason: "x" } } }], rejections: [{ receivedAt: now, tabId: 43, reason: "bad_event", runtimeSource: { sessionId: "43" }, event: { projectId: "P1", taskId: "T2" } }] }) };
  const recoveryController = { getPublicState: () => ({ status: "RECOVERY_REQUIRED", issues: [{ code: "needs_reconcile", sessionId: "42" }], snapshot: { tabId: 42 }, updatedAt: now }) };
  return new ObservabilityService({ projectStore, schedulerStore, reviewStore, integrationStore, registry, eventBus, recoveryController, persistenceInfo: () => ({ backend: "test" }), clock: () => now });
}

test("dashboard exposes project/task/review/integration/agent observability", () => {
  const service = fixture();
  const dashboard = service.dashboard();
  assert.equal(dashboard.observabilityVersion, 1);
  assert.equal(dashboard.project.projectId, "P1");
  assert.equal(dashboard.tasks.length, 2);
  assert.deepEqual(dashboard.tasks.find((task) => task.taskId === "T2").blockers, []);
  assert.equal(dashboard.reviews.items[0].status, "APPROVED");
  assert.equal(dashboard.integration.summary.status, "IDLE");
  assert.equal(dashboard.agents.length, 2);
  assert.equal(dashboard.metrics.tasks.total, 2);
  assert.ok(dashboard.warnings.some((item) => item.code === "blocked"));
  assert.ok(dashboard.warnings.some((item) => item.code === "agent_offline"));
});

test("dashboard and debug bundle never expose browser runtime identifiers", () => {
  const service = fixture();
  const serialized = JSON.stringify(service.dashboard());
  for (const forbidden of ["\"tabId\"", "\"legacyTabId\"", "\"sessionId\"", "\"runtimeSource\""]) assert.equal(serialized.includes(forbidden), false, forbidden);
  const debug = service.debugBundle();
  assert.equal(debug.ok, true);
  for (const forbidden of ["\"tabId\"", "\"sessionId\""]) assert.equal(debug.serialized.includes(forbidden), false, forbidden);
});

test("task detail includes safe controls, blockers and Git evidence", () => {
  const service = fixture();
  const task = service.task("T2");
  assert.equal(task.status, "NEEDS_USER");
  assert.equal(task.controls.canRetry, true);
  assert.equal(task.controls.canCancel, true);
  assert.equal(task.lastRun.failureReason, "blocked");
  assert.equal(service.task("missing"), null);
});

test("warning severity filter is deterministic", () => {
  const service = fixture();
  const all = service.warnings({ minimumSeverity: "info" });
  const errors = service.warnings({ minimumSeverity: "error" });
  assert.ok(all.length >= errors.length);
  assert.ok(errors.every((item) => ["error", "critical"].includes(item.severity)));
});
