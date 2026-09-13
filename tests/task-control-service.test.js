const test = require("node:test");
const assert = require("node:assert/strict");

const { TaskControlService } = require("../background/task-control-service.js");

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function harness({ recoveryStatus = "RUNNING" } = {}) {
  const state = {
    projectId: "P1",
    status: "NEEDS_USER",
    settings: { maxWorkers: 3 },
    tasks: {
      T1: { id: "T1", title: "base", status: "APPROVED", dependencies: [], priority: 10, activeRunId: null, activeReviewId: null },
      T2: { id: "T2", title: "blocked", status: "NEEDS_USER", dependencies: ["T1"], priority: 1, activeRunId: null, activeReviewId: null, lastError: { reason: "blocked" }, completedAt: 10 },
      T3: { id: "T3", title: "downstream", status: "READY", dependencies: ["T2"], priority: 0, activeRunId: null, activeReviewId: null },
      T4: { id: "T4", title: "active", status: "RUNNING", dependencies: [], priority: 0, activeRunId: "R4", activeReviewId: null }
    },
    runs: { R4: { runId: "R4", taskId: "T4", agentId: "A1", status: "RUNNING" } },
    decisionLog: []
  };
  const ticks = [];
  const projectUpdates = [];
  const schedulerStore = {
    state,
    summary: () => ({ projectId: state.projectId, status: state.status, settings: clone(state.settings) }),
    listTasks: () => Object.values(state.tasks).map(clone),
    getTask: (id) => state.tasks[id] ? clone(state.tasks[id]) : null,
    getRun: (id) => state.runs[id] ? clone(state.runs[id]) : null,
    activeRuns: () => Object.values(state.runs).filter((run) => ["ASSIGNED", "RUNNING"].includes(run.status)).map(clone),
    dependenciesSatisfied: (task) => (task.dependencies || []).every((id) => state.tasks[id]?.status === "APPROVED"),
    async persist() {},
    async setStatus(status) { state.status = status; },
    async logDecision(type, details) { state.decisionLog.push({ type, details: clone(details) }); }
  };
  const schedulerEngine = {
    async tick(options) { ticks.push(options); return { ok: true }; },
    availableWorkers: () => [{ agentId: "A2", role: "worker", status: "IDLE" }],
    activeTasks: () => [],
    conflictsWithAny: () => ({ conflict: false }),
    async dispatch(task, agent) {
      state.tasks[task.id].status = "ASSIGNED";
      state.tasks[task.id].activeRunId = "manual-run";
      state.runs["manual-run"] = { runId: "manual-run", taskId: task.id, agentId: agent.agentId, status: "ASSIGNED" };
      return { ok: true, runId: "manual-run" };
    },
    getPublicState: () => schedulerStore.summary()
  };
  const projectStore = { async setExecutionStatus(projectId, status, details) { projectUpdates.push({ projectId, status, details: clone(details) }); } };
  const reviewEngine = { activeCount: () => 0, async tick() { return { ok: true }; }, async enqueueForWorkerCompletion() { return { ok: true, review: { reviewId: "V1" } }; } };
  const integrationEngine = { async tick(options) { return { ok: true, options }; } };
  const registry = {
    getAgent: (id) => id === "A2" ? { agentId: "A2", role: "worker", status: "IDLE" } : null,
    isAgentConnected: (agent) => Boolean(agent),
    async activateAgent(id) { return { ok: true, agentId: id }; }
  };
  const recoveryController = { getPublicState: () => ({ status: recoveryStatus }) };
  const service = new TaskControlService({ schedulerStore, schedulerEngine, projectStore, reviewEngine, integrationEngine, registry, recoveryController, clock: () => 100 });
  return { service, state, ticks, projectUpdates, schedulerStore };
}

test("retry resolves NEEDS_USER by reopening scheduler/project before tick", async () => {
  const { service, state, ticks, projectUpdates } = harness();
  const result = await service.retryTask("T2");
  assert.equal(result.ok, true);
  assert.equal(state.tasks.T2.status, "READY");
  assert.equal(state.status, "RUNNING");
  assert.equal(projectUpdates.at(-1).status, "RUNNING");
  assert.equal(ticks.at(-1).reason, "manual_task_retry");
});

test("cancel refuses downstream graph mutation unless cascade is explicit", async () => {
  const { service, state } = harness();
  const refused = await service.cancelTask("T2");
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, "task_has_downstream_dependents");
  assert.deepEqual(refused.dependentTaskIds, ["T3"]);
  const cancelled = await service.cancelTask("T2", { cascade: true });
  assert.equal(cancelled.ok, true);
  assert.equal(state.tasks.T2.status, "CANCELLED");
  assert.equal(state.tasks.T3.status, "CANCELLED");
  assert.equal(state.status, "RUNNING");
});

test("cancelling every task terminates project as CANCELLED instead of integration-ready", async () => {
  const { service, state, projectUpdates, ticks } = harness();
  state.tasks.T1.status = "READY";
  state.tasks.T4.status = "READY";
  state.tasks.T4.activeRunId = null;
  state.runs = {};

  const first = await service.cancelTask("T4");
  assert.equal(first.ok, true);
  assert.equal(first.terminal, false);

  const tickCountBeforeTerminalCancel = ticks.length;
  const result = await service.cancelTask("T1", { cascade: true });
  assert.equal(result.ok, true);
  assert.equal(result.terminal, true);
  assert.equal(state.status, "CANCELLED");
  assert.equal(Object.values(state.tasks).every((task) => task.status === "CANCELLED"), true);
  assert.equal(projectUpdates.at(-1).status, "CANCELLED");
  assert.equal(projectUpdates.at(-1).details.reason, "all_tasks_cancelled");
  assert.equal(ticks.length, tickCountBeforeTerminalCancel);
  assert.equal(state.decisionLog.some((item) => item.type === "project_cancelled_all_tasks"), true);
});

test("active task cancellation fails closed", async () => {
  const { service, state } = harness();
  const result = await service.cancelTask("T4");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "task_cancel_requires_inactive_tasks");
  assert.equal(state.tasks.T4.status, "RUNNING");
});

test("priority mutation is limited to inactive task states", async () => {
  const { service, state } = harness();
  const changed = await service.changePriority("T2", 999);
  assert.equal(changed.ok, true);
  assert.equal(state.tasks.T2.priority, 100);
  const active = await service.changePriority("T4", 2);
  assert.equal(active.ok, false);
  assert.equal(active.reason, "task_priority_not_mutable");
});

test("manual reassign uses existing scheduler dispatch and fresh worker", async () => {
  const { service, state } = harness();
  const result = await service.reassignAgent("T2", "A2");
  assert.equal(result.ok, true);
  assert.equal(result.runId, "manual-run");
  assert.equal(state.tasks.T2.status, "ASSIGNED");
  assert.equal(state.runs["manual-run"].agentId, "A2");
});

test("unsafe recovery transition blocks task controls", async () => {
  const { service } = harness({ recoveryStatus: "RECOVERING" });
  const retry = await service.retryTask("T2");
  assert.equal(retry.ok, false);
  assert.equal(retry.reason, "task_control_blocked_by_recovery");
  const reassign = await service.reassignAgent("T2", "A2");
  assert.equal(reassign.ok, false);
  assert.equal(reassign.reason, "task_reassign_requires_running_recovery");
});
