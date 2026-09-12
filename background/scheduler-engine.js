(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};
  const TERMINAL_SUCCESS = "DONE_UNVERIFIED";

  function riskRank(value) {
    const normalized = String(value || "medium").toLowerCase();
    return ({ low: 0, medium: 1, high: 2, critical: 3 })[normalized] ?? 1;
  }

  class SchedulerEngine {
    constructor({
      store,
      projectStore,
      registry,
      eventBus,
      sendPrompt,
      clock = () => Date.now(),
      idFactory = null,
      logger = console
    } = {}) {
      this.store = store;
      this.projectStore = projectStore;
      this.registry = registry;
      this.eventBus = eventBus;
      this.sendPrompt = sendPrompt;
      this.clock = clock;
      this.idFactory = idFactory || (() => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`);
      this.logger = logger;
      this.initialized = false;
      this.unsubscribers = [];
      this.tickPromise = Promise.resolve();
    }

    getPublicState() { return this.store.summary(); }
    getRecentDecisions(limit) { return this.store.recentDecisions(limit); }

    async init() {
      if (this.initialized) return this.getPublicState();
      await this.store.load();
      if (!this.unsubscribers.length) {
        this.unsubscribers.push(this.eventBus.subscribe("lifecycle", (record) => this.handleLifecycle(record)));
        this.unsubscribers.push(this.eventBus.subscribe("progress", (record) => this.handleProgress(record)));
        this.unsubscribers.push(this.eventBus.subscribe("completion", (record) => this.handleCompletion(record)));
        this.unsubscribers.push(this.eventBus.subscribe("blocker", (record) => this.handleBlocker(record)));
        this.unsubscribers.push(this.eventBus.subscribe("user", (record) => this.handleNeedsUser(record)));
      }
      await this.restoreActiveContexts();
      this.initialized = true;
      if (this.store.summary().status === "RUNNING") await this.tick({ reason: "service_worker_init" });
      return this.getPublicState();
    }

    async restoreActiveContexts() {
      for (const run of this.store.activeRuns()) {
        const agent = this.registry.getAgent(run.agentId);
        if (!agent) continue;
        await this.registry.setProtocolContext(run.agentId, {
          projectId: this.store.summary().projectId,
          taskId: run.taskId,
          runId: run.runId
        });
      }
    }

    async start({ maxWorkers = 4, maxRetries = 2, runTimeoutMs = null } = {}) {
      const project = this.projectStore.getActiveProject();
      if (!project) return { ok: false, reason: "no_active_project" };
      if (!project.taskGraph?.tasks?.length) return { ok: false, reason: "project_task_graph_missing" };
      if (!["READY", "RUNNING", "NEEDS_USER"].includes(project.status)) {
        return { ok: false, reason: "project_not_ready_for_execution", status: project.status };
      }

      const current = this.store.summary();
      if (current.projectId !== project.projectId || current.taskCount === 0) {
        const initialized = await this.store.initializeProject(project, {
          maxWorkers,
          maxRetries,
          runTimeoutMs: runTimeoutMs || root.SCHEDULER_DEFAULTS?.runTimeoutMs
        });
        if (!initialized.ok) return initialized;
      } else {
        await this.store.setSettings({ maxWorkers, maxRetries, ...(runTimeoutMs ? { runTimeoutMs } : {}) });
        if (current.status === "COMPLETED_UNVERIFIED") return { ok: false, reason: "scheduler_already_complete" };
        await this.store.setStatus("RUNNING");
      }

      await this.projectStore.setExecutionStatus?.(project.projectId, "RUNNING", { phase: 5 });
      await this.store.logDecision("scheduler_started", { settings: this.store.summary().settings });
      await this.tick({ reason: "start_execution" });
      return { ok: true, scheduler: this.getPublicState() };
    }

    downstreamCount(taskId) {
      const tasks = this.store.listTasks();
      const direct = new Map(tasks.map((task) => [task.id, []]));
      for (const task of tasks) {
        for (const dependency of task.dependencies || []) direct.get(dependency)?.push(task.id);
      }
      const seen = new Set();
      const visit = (id) => {
        for (const child of direct.get(id) || []) {
          if (seen.has(child)) continue;
          seen.add(child);
          visit(child);
        }
      };
      visit(taskId);
      return seen.size;
    }

    sortCandidates(tasks) {
      return [...tasks].sort((a, b) => (
        this.downstreamCount(b.id) - this.downstreamCount(a.id)
        || (Number(b.priority) || 0) - (Number(a.priority) || 0)
        || riskRank(a.risk) - riskRank(b.risk)
        || a.id.localeCompare(b.id)
      ));
    }

    availableWorkers() {
      const activeAgentIds = new Set(this.store.activeRuns().map((run) => run.agentId));
      return this.registry.listAgents().filter((agent) => (
        agent.role === "worker"
        && Number.isInteger(agent.tabId)
        && agent.status === "IDLE"
        && !activeAgentIds.has(agent.agentId)
      ));
    }

    activeTasks() {
      return this.store.activeRuns().map((run) => this.store.getTask(run.taskId)).filter(Boolean);
    }

    conflictsWithAny(task, activeTasks) {
      for (const active of activeTasks) {
        const conflict = root.SchedulerConflictPolicy.conflictScore(task, active);
        if (conflict.mutuallyExclusive) return { conflict: true, withTaskId: active.id, ...conflict };
      }
      return { conflict: false, score: 0, reasons: [] };
    }

    async dispatch(task, agent) {
      const project = this.projectStore.getActiveProject();
      if (!project || project.projectId !== this.store.summary().projectId) return { ok: false, reason: "project_context_changed" };
      const runId = `run-${this.idFactory()}`;
      const locks = root.SchedulerConflictPolicy.resourceKeys(task);
      const created = await this.store.createRun({ taskId: task.id, runId, agentId: agent.agentId, locks });
      if (!created.ok) return created;

      await this.registry.setProtocolContext(agent.agentId, { projectId: project.projectId, taskId: task.id, runId });
      const definition = task.definition || task;
      const prompt = root.WorkerPrompts.buildWorkerPrompt({ project, task: definition, runId, agentId: agent.agentId });
      const result = await this.sendPrompt(agent.agentId, prompt);
      if (!result?.ok) {
        const failed = await this.store.markFailure(runId, "dispatch_failed", { retryable: true });
        await this.registry.clearProtocolContext(agent.agentId);
        await this.store.logDecision("dispatch_failed", { taskId: task.id, runId, agentId: agent.agentId, result });
        if (failed?.task?.status === "NEEDS_USER") await this.escalate("dispatch_retries_exhausted", failed.task);
        return { ok: false, reason: "dispatch_failed", details: result };
      }

      await this.store.logDecision("task_assigned", {
        taskId: task.id,
        runId,
        agentId: agent.agentId,
        locks,
        downstream: this.downstreamCount(task.id),
        priority: task.priority
      });
      return { ok: true, runId };
    }

    async tick({ reason = "tick" } = {}) {
      this.tickPromise = this.tickPromise.catch(() => {}).then(() => this._tick({ reason }));
      return this.tickPromise;
    }

    async _tick({ reason }) {
      const state = this.store.summary();
      if (state.status !== "RUNNING") return { ok: false, reason: "scheduler_not_running", scheduler: state };

      await this.checkWatchdog();
      if (this.store.summary().status !== "RUNNING") return { ok: false, reason: "scheduler_stopped_by_watchdog", scheduler: this.getPublicState() };

      const maxWorkers = this.store.summary().settings.maxWorkers;
      let workers = this.availableWorkers();
      let active = this.activeTasks();
      let capacity = Math.max(0, maxWorkers - this.store.activeRuns().length);
      let candidates = this.sortCandidates(this.store.runnableTasks());
      const assigned = [];

      while (capacity > 0 && workers.length && candidates.length) {
        let selectedIndex = -1;
        for (let index = 0; index < candidates.length; index += 1) {
          const candidate = candidates[index];
          const conflict = this.conflictsWithAny(candidate, active);
          if (!conflict.conflict) {
            selectedIndex = index;
            break;
          }
          await this.store.logDecision("task_deferred_conflict", {
            taskId: candidate.id,
            withTaskId: conflict.withTaskId,
            reasons: conflict.reasons,
            score: conflict.score,
            trigger: reason
          });
        }
        if (selectedIndex < 0) break;

        const task = candidates.splice(selectedIndex, 1)[0];
        const worker = workers.shift();
        const result = await this.dispatch(task, worker);
        if (result.ok) {
          assigned.push({ taskId: task.id, runId: result.runId, agentId: worker.agentId });
          active.push(this.store.getTask(task.id));
          capacity -= 1;
        }
        candidates = this.sortCandidates(this.store.runnableTasks());
      }

      if (this.store.isComplete()) {
        await this.store.setStatus("COMPLETED_UNVERIFIED");
        const projectId = this.store.summary().projectId;
        await this.projectStore.setExecutionStatus?.(projectId, "COMPLETED_UNVERIFIED", { phase: 5 });
        await this.store.logDecision("scheduler_completed", { policy: TERMINAL_SUCCESS });
      } else if (!assigned.length && !this.store.activeRuns().length && !this.store.runnableTasks().length) {
        await this.store.logDecision("scheduler_stalled", {
          trigger: reason,
          unfinished: this.store.listTasks().filter((task) => task.status !== TERMINAL_SUCCESS).map((task) => ({ id: task.id, status: task.status }))
        });
      }

      return { ok: true, assigned, scheduler: this.getPublicState() };
    }

    matchesActiveRun(record) {
      const event = record?.event;
      if (!event || event.projectId !== this.store.summary().projectId) return null;
      const run = this.store.getRun(event.runId);
      if (!run || run.taskId !== event.taskId || run.agentId !== event.agentId) return null;
      if (!["ASSIGNED", "RUNNING"].includes(run.status)) return null;
      return run;
    }

    async handleLifecycle(record) {
      const run = this.matchesActiveRun(record);
      if (!run) return;
      const type = record.event.event;
      if (type === "TASK_ACCEPTED") await this.store.markRunning(run.runId);
      else if (type === "HEARTBEAT" || type === "READY") await this.store.touchRun(run.runId);
    }

    async handleProgress(record) {
      const run = this.matchesActiveRun(record);
      if (!run || record.event.event !== "PROGRESS") return;
      await this.store.markRunning(run.runId);
    }

    async handleCompletion(record) {
      const run = this.matchesActiveRun(record);
      if (!run || record.event.event !== "DONE") return;
      await this.store.markDone(run.runId);
      await this.registry.clearProtocolContext(run.agentId);
      await this.store.logDecision("task_done_unverified", { taskId: run.taskId, runId: run.runId, agentId: run.agentId });
      await this.tick({ reason: "task_done" });
    }

    async handleBlocker(record) {
      const run = this.matchesActiveRun(record);
      if (!run || !["BLOCKED", "ERROR"].includes(record.event.event)) return;
      const payload = record.event.payload || {};
      const retryable = payload.retryable !== false;
      const result = await this.store.markFailure(run.runId, record.event.event.toLowerCase(), { retryable });
      await this.registry.clearProtocolContext(run.agentId);
      await this.store.logDecision("task_failed", {
        taskId: run.taskId,
        runId: run.runId,
        agentId: run.agentId,
        event: record.event.event,
        retryable,
        nextStatus: result?.task?.status || null
      });
      if (result?.task?.status === "NEEDS_USER") await this.escalate(`${record.event.event.toLowerCase()}_requires_user`, result.task);
      else await this.tick({ reason: "retryable_failure" });
    }

    async handleNeedsUser(record) {
      const run = this.matchesActiveRun(record);
      if (!run || record.event.event !== "NEEDS_USER") return;
      const result = await this.store.markFailure(run.runId, "needs_user", { retryable: false, needsUser: true });
      await this.registry.clearProtocolContext(run.agentId);
      await this.escalate("worker_needs_user", result?.task || this.store.getTask(run.taskId));
    }

    async escalate(reason, task) {
      await this.store.setStatus("NEEDS_USER");
      const projectId = this.store.summary().projectId;
      await this.projectStore.setExecutionStatus?.(projectId, "NEEDS_USER", { phase: 5, reason, taskId: task?.id || null });
      await this.store.logDecision("needs_user", { reason, taskId: task?.id || null });
    }

    async checkWatchdog() {
      const now = this.clock();
      const timeout = this.store.summary().settings.runTimeoutMs;
      for (const run of this.store.activeRuns()) {
        const reference = run.lastEventAt || run.startedAt || run.assignedAt;
        if (!reference || now - reference < timeout) continue;
        const result = await this.store.markFailure(run.runId, "timeout", { retryable: true });
        await this.registry.clearProtocolContext(run.agentId);
        await this.store.logDecision("run_timeout", { taskId: run.taskId, runId: run.runId, agentId: run.agentId, timeoutMs: timeout });
        if (result?.task?.status === "NEEDS_USER") {
          await this.escalate("watchdog_retries_exhausted", result.task);
          break;
        }
      }
    }

    async handleAgentUnavailable(agentId, reason = "agent_unavailable") {
      const run = this.store.activeRuns().find((item) => item.agentId === agentId);
      if (!run) return { ok: true, ignored: true };
      const result = await this.store.markFailure(run.runId, reason, { retryable: true });
      await this.registry.clearProtocolContext(agentId);
      await this.store.logDecision("agent_unavailable", { agentId, runId: run.runId, taskId: run.taskId, reason });
      if (result?.task?.status === "NEEDS_USER") await this.escalate("agent_retries_exhausted", result.task);
      else await this.tick({ reason: "agent_unavailable" });
      return { ok: true };
    }

    async handleAgentStateChanged(agent) {
      if (this.store.summary().status !== "RUNNING") return;
      if (agent?.role === "worker" && agent.status === "IDLE") await this.tick({ reason: "worker_idle" });
    }
  }

  root.SchedulerEngine = SchedulerEngine;
  root.PHASE5_DEPENDENCY_SUCCESS = TERMINAL_SUCCESS;

  if (typeof module !== "undefined" && module.exports) module.exports = { SchedulerEngine, TERMINAL_SUCCESS, riskRank };
})();
