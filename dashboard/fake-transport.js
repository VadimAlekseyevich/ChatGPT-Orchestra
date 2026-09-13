(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};

  function clone(value) {
    if (typeof structuredClone === "function") return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }

  function defaultDashboard() {
    const now = Date.now();
    return {
      observabilityVersion: 1,
      revision: now,
      generatedAt: now,
      project: {
        projectId: "demo-project",
        status: "RUNNING",
        stage: "EXECUTION",
        goal: "Standalone Dashboard fixture",
        repository: { url: "https://github.com/example/orchestra-demo", fullName: "example/orchestra-demo" },
        validation: { ok: true },
        execution: { status: "RUNNING" },
        createdAt: now - 120000,
        updatedAt: now
      },
      scheduler: {
        projectId: "demo-project",
        status: "RUNNING",
        settings: { maxWorkers: 3 },
        git: { defaultBranch: "main", baseSha: "0123456789abcdef0123456789abcdef01234567" },
        taskCount: 3,
        counts: { APPROVED: 1, RUNNING: 1, READY: 1 },
        activeRuns: 1,
        updatedAt: now
      },
      tasks: [
        { taskId: "T1", title: "Foundation", objective: "Create shared foundation", kind: "code", status: "APPROVED", dependencies: [], blockers: [], priority: 10, risk: "medium", estimatedComplexity: "M", scope: { allow: ["src/core/**"] }, acceptanceCriteria: ["Core contract exists"], verification: ["npm test"], attempts: 1, reviewIterations: 1, lastArtifact: { branch: "orchestra/demo/T1/run-1", commit: "1111111111111111111111111111111111111111" }, lastReview: { status: "APPROVED" }, controls: {}, updatedAt: now - 50000 },
        { taskId: "T2", title: "Worker", objective: "Implement worker behavior", kind: "code", status: "RUNNING", dependencies: ["T1"], blockers: [], priority: 5, risk: "medium", estimatedComplexity: "M", scope: { allow: ["src/worker/**"] }, acceptanceCriteria: ["Worker passes tests"], verification: ["npm test"], attempts: 1, reviewIterations: 0, activeRunId: "run-2", activeRun: { runId: "run-2", taskId: "T2", agentId: "worker-1", status: "RUNNING", startedAt: now - 20000, lastEventAt: now - 1000 }, controls: {}, updatedAt: now },
        { taskId: "T3", title: "Docs", objective: "Document the feature", kind: "docs", status: "READY", dependencies: ["T1"], blockers: [], priority: 1, risk: "low", estimatedComplexity: "S", scope: { allow: ["docs/**"] }, acceptanceCriteria: ["Docs updated"], verification: ["manual review"], attempts: 0, reviewIterations: 0, controls: { canRetry: false, canCancel: true, canChangePriority: true, canReassign: true, canRequestReview: false }, updatedAt: now }
      ],
      activeRuns: [{ runId: "run-2", taskId: "T2", agentId: "worker-1", status: "RUNNING", startedAt: now - 20000, lastEventAt: now - 1000 }],
      reviews: { summary: { total: 1, active: 0, pending: 0 }, items: [{ reviewId: "review-1", taskId: "T1", workerRunId: "run-1", authorAgentId: "worker-1", reviewerAgentId: "worker-2", iteration: 1, status: "APPROVED", result: { summary: "Looks good" }, completedAt: now - 40000 }] },
      integration: { summary: { status: "IDLE", currentRun: null, summary: null }, runs: [], repairs: [] },
      recovery: { status: "RUNNING", issues: [], updatedAt: now },
      agents: [
        { agentId: "lead-1", role: "lead", label: "Lead", status: "IDLE", connected: true, lastSeenAt: now, executorRef: { agentId: "lead-1" } },
        { agentId: "worker-1", role: "worker", label: "Worker 1", status: "BUSY", connected: true, lastSeenAt: now, activeContext: { taskId: "T2", runId: "run-2" }, executorRef: { agentId: "worker-1" } },
        { agentId: "worker-2", role: "worker", label: "Worker 2", status: "IDLE", connected: true, lastSeenAt: now, executorRef: { agentId: "worker-2" } }
      ],
      decisions: [{ at: now - 20000, type: "task_assigned", details: { taskId: "T2", agentId: "worker-1" } }],
      events: [{ receivedAt: now - 1000, event: { event: "PROGRESS", taskId: "T2", payload: { summary: "Working" } } }],
      rejections: [],
      warnings: [],
      metrics: { tasks: { total: 3, approved: 1, cancelled: 0, finished: 1, progress: 1 / 3, byStatus: { APPROVED: 1, RUNNING: 1, READY: 1 } }, runs: { total: 2, active: 1, averageDurationMs: 15000 }, reviews: { total: 1, active: 0, approved: 1, changesRequired: 0 }, agents: { total: 3, connected: 3, busy: 1, idle: 2, offline: 0 }, updatedAt: now },
      persistence: { backend: "fake", portableSchemaVersion: 1, bundleVersion: 1 }
    };
  }

  class FakeDashboardTransport {
    constructor({ dashboard = null } = {}) {
      this.dashboard = clone(dashboard || defaultDashboard());
      this.commands = [];
    }

    refreshMetrics() {
      const tasks = this.dashboard.tasks || [];
      const byStatus = {};
      for (const task of tasks) byStatus[task.status] = (byStatus[task.status] || 0) + 1;
      const finished = (byStatus.APPROVED || 0) + (byStatus.CANCELLED || 0);
      this.dashboard.metrics.tasks = { total: tasks.length, approved: byStatus.APPROVED || 0, cancelled: byStatus.CANCELLED || 0, finished, progress: tasks.length ? finished / tasks.length : 0, byStatus };
      this.dashboard.scheduler.counts = byStatus;
      this.dashboard.scheduler.taskCount = tasks.length;
      this.dashboard.revision = Date.now();
      this.dashboard.generatedAt = Date.now();
    }

    async query(name, payload = {}) {
      const query = String(name || "");
      if (query === "dashboard") return { apiVersion: 3, ok: true, dashboard: clone(this.dashboard) };
      if (query === "taskDetails") {
        const task = this.dashboard.tasks.find((item) => item.taskId === payload.taskId);
        return task ? { apiVersion: 3, ok: true, task: clone(task) } : { apiVersion: 3, ok: false, reason: "unknown_task" };
      }
      if (query === "agents") return { apiVersion: 3, ok: true, agents: clone(this.dashboard.agents) };
      if (query === "warnings") return { apiVersion: 3, ok: true, warnings: clone(this.dashboard.warnings) };
      if (query === "metrics") return { apiVersion: 3, ok: true, metrics: clone(this.dashboard.metrics) };
      return { apiVersion: 3, ok: false, reason: "unknown_api_query" };
    }

    async execute(name, payload = {}) {
      const command = String(name || "");
      this.commands.push({ name: command, payload: clone(payload) });
      const task = payload.taskId ? this.dashboard.tasks.find((item) => item.taskId === payload.taskId) : null;
      if (command === "pause") this.dashboard.recovery.status = "PAUSED";
      else if (command === "resume") this.dashboard.recovery.status = "RUNNING";
      else if (command === "stopNow") this.dashboard.recovery.status = "STOPPED";
      else if (command === "changePriority" && task) task.priority = Number(payload.priority) || 0;
      else if (command === "cancelTask" && task) task.status = "CANCELLED";
      else if (command === "retryTask" && task) task.status = "READY";
      else if (command === "requestReview" && task) task.status = "REVIEW_PENDING";
      else if (command === "reassignAgent" && task) {
        task.status = "ASSIGNED";
        task.activeRunId = `fake-${Date.now()}`;
      }
      else if (command === "startIntegration") this.dashboard.integration.summary.status = "PENDING";
      else if (command === "openExecutor") return { apiVersion: 3, ok: true, agentId: payload.agentId };
      else if (["exportProjectBundle", "exportDebugBundle"].includes(command)) {
        const serialized = JSON.stringify({ command, dashboard: this.dashboard }, null, 2);
        return { apiVersion: 3, ok: true, filename: `${command}.json`, serialized, bytes: serialized.length };
      }
      else if (!["pause", "resume", "stopNow", "changePriority", "cancelTask", "retryTask", "requestReview", "reassignAgent", "startIntegration"].includes(command)) return { apiVersion: 3, ok: false, reason: "unknown_api_command" };
      this.refreshMetrics();
      return { apiVersion: 3, ok: true };
    }
  }

  root.FakeDashboardTransport = FakeDashboardTransport;
  root.fakeDashboardFixture = defaultDashboard;
  if (typeof module !== "undefined" && module.exports) module.exports = { FakeDashboardTransport, defaultDashboard };
})();
