(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};
  const STORAGE_KEY = "orchestra.scheduler.v1";
  const SCHEMA_VERSION = 1;
  const DEFAULTS = Object.freeze({ maxWorkers: 4, maxRetries: 2, runTimeoutMs: 20 * 60 * 1000 });

  function clone(value) {
    if (typeof structuredClone === "function") return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }

  function defaultState() {
    return {
      schemaVersion: SCHEMA_VERSION,
      projectId: null,
      status: "IDLE",
      settings: { ...DEFAULTS },
      tasks: {},
      runs: {},
      decisionLog: [],
      createdAt: 0,
      updatedAt: 0
    };
  }

  function normalizeSettings(settings = {}) {
    return {
      maxWorkers: Math.max(1, Math.min(4, Number(settings.maxWorkers) || DEFAULTS.maxWorkers)),
      maxRetries: Math.max(0, Math.min(5, Number.isFinite(Number(settings.maxRetries)) ? Number(settings.maxRetries) : DEFAULTS.maxRetries)),
      runTimeoutMs: Math.max(60_000, Math.min(2 * 60 * 60 * 1000, Number(settings.runTimeoutMs) || DEFAULTS.runTimeoutMs))
    };
  }

  function normalizeTask(task) {
    return {
      id: String(task.id),
      title: String(task.title || task.id),
      objective: String(task.objective || ""),
      kind: String(task.kind || "code"),
      dependencies: Array.isArray(task.dependencies) ? [...task.dependencies] : [],
      scope: clone(task.scope || { allow: [] }),
      acceptanceCriteria: Array.isArray(task.acceptanceCriteria) ? [...task.acceptanceCriteria] : [],
      verification: Array.isArray(task.verification) ? [...task.verification] : [],
      verificationWaiver: task.verificationWaiver || null,
      priority: Number(task.priority) || 0,
      risk: String(task.risk || "medium"),
      estimatedComplexity: String(task.estimatedComplexity || "M"),
      resourceLocks: Array.isArray(task.resourceLocks) ? [...task.resourceLocks] : [],
      subsystem: task.subsystem || null,
      status: "READY",
      attempts: 0,
      activeRunId: null,
      lastRunId: null,
      lastError: null,
      completedAt: null,
      updatedAt: 0
    };
  }

  class SchedulerStore {
    constructor({ storageArea = globalThis.chrome?.storage?.local, clock = () => Date.now(), maxDecisionLog = 1000 } = {}) {
      this.storageArea = storageArea;
      this.clock = clock;
      this.maxDecisionLog = Math.max(100, Number(maxDecisionLog) || 1000);
      this.state = defaultState();
      this.writeChain = Promise.resolve();
    }

    async load() {
      if (!this.storageArea?.get) return this.snapshot();
      const stored = await this.storageArea.get(STORAGE_KEY);
      const candidate = stored?.[STORAGE_KEY];
      if (candidate?.schemaVersion === SCHEMA_VERSION) {
        this.state = {
          ...defaultState(),
          ...candidate,
          settings: normalizeSettings(candidate.settings),
          tasks: { ...(candidate.tasks || {}) },
          runs: { ...(candidate.runs || {}) },
          decisionLog: Array.isArray(candidate.decisionLog) ? [...candidate.decisionLog] : []
        };
      }
      return this.snapshot();
    }

    snapshot() { return clone(this.state); }
    getTask(taskId) { const task = this.state.tasks[taskId]; return task ? clone(task) : null; }
    getRun(runId) { const run = this.state.runs[runId]; return run ? clone(run) : null; }
    listTasks() { return Object.values(this.state.tasks).map(clone); }
    listRuns() { return Object.values(this.state.runs).map(clone); }
    activeRuns() { return this.listRuns().filter((run) => ["ASSIGNED", "RUNNING"].includes(run.status)); }

    summary() {
      const tasks = this.listTasks();
      const counts = {};
      for (const task of tasks) counts[task.status] = (counts[task.status] || 0) + 1;
      return {
        schemaVersion: this.state.schemaVersion,
        projectId: this.state.projectId,
        status: this.state.status,
        settings: clone(this.state.settings),
        taskCount: tasks.length,
        counts,
        activeRuns: this.activeRuns().length,
        decisionCursor: this.state.decisionLog.length,
        updatedAt: this.state.updatedAt
      };
    }

    async persist() {
      this.state.updatedAt = this.clock();
      if (!this.storageArea?.set) return this.snapshot();
      const payload = clone(this.state);
      this.writeChain = this.writeChain.catch(() => {}).then(() => this.storageArea.set({ [STORAGE_KEY]: payload }));
      await this.writeChain;
      return this.snapshot();
    }

    async initializeProject(project, settings = {}) {
      if (!project?.projectId || !Array.isArray(project?.taskGraph?.tasks)) return { ok: false, reason: "project_task_graph_missing" };
      const now = this.clock();
      this.state = defaultState();
      this.state.projectId = project.projectId;
      this.state.status = "RUNNING";
      this.state.settings = normalizeSettings(settings);
      this.state.createdAt = now;
      for (const rawTask of project.taskGraph.tasks) {
        const task = normalizeTask(rawTask);
        task.updatedAt = now;
        this.state.tasks[task.id] = task;
      }
      await this.persist();
      return { ok: true, state: this.summary() };
    }

    async setStatus(status) {
      this.state.status = String(status || "IDLE");
      await this.persist();
      return this.summary();
    }

    async setSettings(settings = {}) {
      this.state.settings = normalizeSettings({ ...this.state.settings, ...settings });
      await this.persist();
      return clone(this.state.settings);
    }

    async logDecision(type, details = {}) {
      this.state.decisionLog.push({ at: this.clock(), type: String(type || "decision"), details: clone(details) });
      if (this.state.decisionLog.length > this.maxDecisionLog) {
        this.state.decisionLog.splice(0, this.state.decisionLog.length - this.maxDecisionLog);
      }
      await this.persist();
    }

    recentDecisions(limit = 100) {
      const count = Math.max(1, Math.min(500, Number(limit) || 100));
      return clone(this.state.decisionLog.slice(-count));
    }

    async createRun({ taskId, runId, agentId, locks = [] }) {
      const task = this.state.tasks[taskId];
      if (!task) return { ok: false, reason: "unknown_task" };
      if (task.status !== "READY") return { ok: false, reason: "task_not_ready", status: task.status };
      const now = this.clock();
      task.status = "ASSIGNED";
      task.attempts += 1;
      task.activeRunId = runId;
      task.lastRunId = runId;
      task.updatedAt = now;
      task.lastError = null;
      this.state.runs[runId] = {
        runId,
        taskId,
        agentId,
        status: "ASSIGNED",
        attempt: task.attempts,
        locks: [...locks],
        assignedAt: now,
        startedAt: null,
        lastEventAt: now,
        finishedAt: null,
        failureReason: null
      };
      await this.persist();
      return { ok: true, task: this.getTask(taskId), run: this.getRun(runId) };
    }

    async markRunning(runId) {
      const run = this.state.runs[runId];
      if (!run) return null;
      const task = this.state.tasks[run.taskId];
      const now = this.clock();
      if (["ASSIGNED", "RUNNING"].includes(run.status)) run.status = "RUNNING";
      if (!run.startedAt) run.startedAt = now;
      run.lastEventAt = now;
      if (task && ["ASSIGNED", "RUNNING"].includes(task.status)) {
        task.status = "RUNNING";
        task.updatedAt = now;
      }
      await this.persist();
      return { task: task ? this.getTask(task.id) : null, run: this.getRun(runId) };
    }

    async touchRun(runId) {
      const run = this.state.runs[runId];
      if (!run) return null;
      run.lastEventAt = this.clock();
      await this.persist();
      return this.getRun(runId);
    }

    async markDone(runId) {
      const run = this.state.runs[runId];
      if (!run) return null;
      const task = this.state.tasks[run.taskId];
      const now = this.clock();
      run.status = "DONE";
      run.lastEventAt = now;
      run.finishedAt = now;
      if (task) {
        task.status = "DONE_UNVERIFIED";
        task.activeRunId = null;
        task.completedAt = now;
        task.updatedAt = now;
        task.lastError = null;
      }
      await this.persist();
      return { task: task ? this.getTask(task.id) : null, run: this.getRun(runId) };
    }

    async markFailure(runId, reason, { retryable = true, needsUser = false } = {}) {
      const run = this.state.runs[runId];
      if (!run) return null;
      const task = this.state.tasks[run.taskId];
      const now = this.clock();
      run.status = needsUser ? "NEEDS_USER" : String(reason || "FAILED").toUpperCase();
      run.failureReason = String(reason || "failed");
      run.lastEventAt = now;
      run.finishedAt = now;
      if (task) {
        task.activeRunId = null;
        task.lastError = { reason: run.failureReason, at: now };
        const retriesRemaining = task.attempts <= this.state.settings.maxRetries;
        task.status = needsUser || !retryable || !retriesRemaining ? "NEEDS_USER" : "READY";
        task.updatedAt = now;
      }
      await this.persist();
      return { task: task ? this.getTask(task.id) : null, run: this.getRun(runId) };
    }

    dependenciesSatisfied(task) {
      return (task.dependencies || []).every((dependencyId) => this.state.tasks[dependencyId]?.status === "DONE_UNVERIFIED");
    }

    runnableTasks() {
      return this.listTasks().filter((task) => task.status === "READY" && this.dependenciesSatisfied(task));
    }

    isComplete() {
      const tasks = this.listTasks();
      return tasks.length > 0 && tasks.every((task) => ["DONE_UNVERIFIED", "CANCELLED"].includes(task.status));
    }
  }

  root.SchedulerStore = SchedulerStore;
  root.SCHEDULER_STORAGE_KEY = STORAGE_KEY;
  root.SCHEDULER_DEFAULTS = DEFAULTS;
  root.normalizeSchedulerSettings = normalizeSettings;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { SchedulerStore, STORAGE_KEY, SCHEMA_VERSION, DEFAULTS, normalizeSettings, normalizeTask };
  }
})();
