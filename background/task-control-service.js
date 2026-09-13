(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};

  class TaskControlService {
    constructor({ schedulerStore, schedulerEngine, projectStore = null, reviewStore, reviewEngine, integrationEngine, registry, recoveryController = null, clock = () => Date.now() } = {}) {
      this.schedulerStore = schedulerStore;
      this.schedulerEngine = schedulerEngine;
      this.projectStore = projectStore;
      this.reviewStore = reviewStore;
      this.reviewEngine = reviewEngine;
      this.integrationEngine = integrationEngine;
      this.registry = registry;
      this.recoveryController = recoveryController;
      this.clock = clock;
      this.chain = Promise.resolve();
    }

    serialize(callback) {
      const next = this.chain.catch(() => {}).then(callback);
      this.chain = next.then(() => undefined, () => undefined);
      return next;
    }

    recoveryStatus() { return String(this.recoveryController?.getPublicState?.()?.status || "RUNNING"); }
    recoveryAllowsMutation() { return ["IDLE", "RUNNING", "PAUSED", "STOPPED", "RECOVERY_REQUIRED"].includes(this.recoveryStatus()); }
    mutableTask(taskId) { return this.schedulerStore?.state?.tasks?.[String(taskId || "")] || null; }

    async reopenExecution(reason, details = {}) {
      if (this.schedulerStore?.summary?.().status !== "RUNNING") await this.schedulerStore?.setStatus?.("RUNNING");
      const projectId = this.schedulerStore?.summary?.().projectId;
      if (projectId) await this.projectStore?.setExecutionStatus?.(projectId, "RUNNING", { phase: 12, reason, ...details });
    }

    downstreamTaskIds(taskId) {
      const tasks = this.schedulerStore?.listTasks?.() || [];
      const direct = new Map(tasks.map((task) => [task.id, []]));
      for (const task of tasks) for (const dependency of task.dependencies || []) direct.get(dependency)?.push(task.id);
      const output = [];
      const seen = new Set();
      const visit = (id) => {
        for (const child of direct.get(id) || []) {
          if (seen.has(child)) continue;
          seen.add(child);
          output.push(child);
          visit(child);
        }
      };
      visit(String(taskId || ""));
      return output;
    }

    async retryTask(taskId) {
      return this.serialize(async () => {
        if (!this.recoveryAllowsMutation()) return { ok: false, reason: "task_control_blocked_by_recovery" };
        const task = this.mutableTask(taskId);
        if (!task) return { ok: false, reason: "unknown_task" };
        if (task.activeRunId || task.activeReviewId) return { ok: false, reason: "task_has_active_role" };
        if (task.status !== "NEEDS_USER") return { ok: false, reason: "task_retry_requires_needs_user", status: task.status };
        task.status = "READY";
        task.lastError = null;
        task.completedAt = null;
        task.approvedAt = null;
        task.updatedAt = this.clock();
        await this.schedulerStore.persist();
        await this.schedulerStore.logDecision("manual_task_retry", { taskId: task.id });
        await this.reopenExecution("manual_task_retry", { taskId: task.id });
        if (this.recoveryStatus() === "RUNNING") await this.schedulerEngine?.tick?.({ reason: "manual_task_retry" });
        return { ok: true, task: this.schedulerStore.getTask(task.id) };
      });
    }

    async cancelTask(taskId, { cascade = false } = {}) {
      return this.serialize(async () => {
        if (!this.recoveryAllowsMutation()) return { ok: false, reason: "task_control_blocked_by_recovery" };
        const task = this.mutableTask(taskId);
        if (!task) return { ok: false, reason: "unknown_task" };
        const downstream = this.downstreamTaskIds(task.id).filter((id) => !["APPROVED", "CANCELLED"].includes(this.schedulerStore.getTask(id)?.status));
        if (downstream.length && !cascade) return { ok: false, reason: "task_has_downstream_dependents", dependentTaskIds: downstream };
        const ids = cascade ? [task.id, ...downstream] : [task.id];
        const blocked = ids.map((id) => this.schedulerStore.getTask(id)).filter((item) => item && !["READY", "NEEDS_USER", "CANCELLED"].includes(item.status));
        if (blocked.length) return { ok: false, reason: "task_cancel_requires_inactive_tasks", taskIds: blocked.map((item) => item.id), statuses: blocked.map((item) => item.status) };
        const now = this.clock();
        for (const id of ids) {
          const mutable = this.mutableTask(id);
          if (!mutable || mutable.status === "CANCELLED") continue;
          mutable.status = "CANCELLED";
          mutable.activeRunId = null;
          mutable.activeReviewId = null;
          mutable.lastError = { reason: "cancelled_by_user", at: now };
          mutable.updatedAt = now;
        }
        await this.schedulerStore.persist();
        await this.schedulerStore.logDecision("tasks_cancelled", { taskId: task.id, cascade: Boolean(cascade), cancelledTaskIds: ids });
        await this.reopenExecution("tasks_cancelled", { taskId: task.id, cascade: Boolean(cascade), cancelledTaskIds: ids });
        if (this.recoveryStatus() === "RUNNING") await this.schedulerEngine?.tick?.({ reason: "tasks_cancelled" });
        return { ok: true, cancelledTaskIds: ids, scheduler: this.schedulerEngine?.getPublicState?.() || this.schedulerStore.summary() };
      });
    }

    async changePriority(taskId, priority) {
      return this.serialize(async () => {
        if (!this.recoveryAllowsMutation()) return { ok: false, reason: "task_control_blocked_by_recovery" };
        const task = this.mutableTask(taskId);
        if (!task) return { ok: false, reason: "unknown_task" };
        if (task.activeRunId || !["READY", "NEEDS_USER"].includes(task.status)) return { ok: false, reason: "task_priority_not_mutable", status: task.status };
        const normalized = Math.max(-100, Math.min(100, Number(priority) || 0));
        task.priority = normalized;
        task.updatedAt = this.clock();
        await this.schedulerStore.persist();
        await this.schedulerStore.logDecision("task_priority_changed", { taskId: task.id, priority: normalized });
        if (this.recoveryStatus() === "RUNNING") await this.schedulerEngine?.tick?.({ reason: "task_priority_changed" });
        return { ok: true, task: this.schedulerStore.getTask(task.id) };
      });
    }

    async reassignAgent(taskId, agentId) {
      return this.serialize(async () => {
        if (this.recoveryStatus() !== "RUNNING") return { ok: false, reason: "task_reassign_requires_running_recovery" };
        let task = this.schedulerStore.getTask(taskId);
        if (!task) return { ok: false, reason: "unknown_task" };
        if (task.activeRunId || task.activeReviewId || !["READY", "NEEDS_USER"].includes(task.status)) return { ok: false, reason: "task_reassign_requires_idle_task", status: task.status };
        const agent = this.registry?.getAgent?.(agentId);
        if (!agent || agent.role !== "worker" || !this.registry?.isAgentConnected?.(agent) || agent.status !== "IDLE") return { ok: false, reason: "target_agent_not_idle", agentId };
        const available = (this.schedulerEngine?.availableWorkers?.() || []).some((item) => item.agentId === agent.agentId);
        if (!available) return { ok: false, reason: "target_agent_unavailable", agentId };
        if (task.status === "NEEDS_USER") {
          const mutable = this.mutableTask(task.id);
          mutable.status = "READY";
          mutable.lastError = null;
          mutable.completedAt = null;
          mutable.updatedAt = this.clock();
          await this.schedulerStore.persist();
          task = this.schedulerStore.getTask(task.id);
          await this.reopenExecution("manual_task_reassign", { taskId: task.id, agentId: agent.agentId });
        }
        if (!this.schedulerStore.dependenciesSatisfied(task)) return { ok: false, reason: "task_dependencies_not_satisfied" };
        const conflict = this.schedulerEngine?.conflictsWithAny?.(task, this.schedulerEngine?.activeTasks?.() || []);
        if (conflict?.conflict) return { ok: false, reason: "task_conflicts_with_active_work", conflict };
        const maxWorkers = Number(this.schedulerStore.summary().settings?.maxWorkers) || 1;
        const activeRoles = (this.schedulerStore.activeRuns?.().length || 0) + (this.reviewEngine?.activeCount?.() || 0);
        if (activeRoles >= maxWorkers) return { ok: false, reason: "worker_capacity_full" };
        const dispatched = await this.schedulerEngine?.dispatch?.(task, agent);
        if (!dispatched?.ok) return dispatched || { ok: false, reason: "task_dispatch_failed" };
        await this.schedulerStore.logDecision("task_reassigned", { taskId: task.id, agentId: agent.agentId, runId: dispatched.runId || dispatched.run?.runId || null });
        return { ok: true, task: this.schedulerStore.getTask(task.id), run: dispatched.run || null, runId: dispatched.runId || null };
      });
    }

    async requestReview(taskId) {
      return this.serialize(async () => {
        if (this.recoveryStatus() !== "RUNNING") return { ok: false, reason: "review_request_requires_running_recovery" };
        const task = this.schedulerStore.getTask(taskId);
        if (!task) return { ok: false, reason: "unknown_task" };
        if (task.status === "REVIEWING") return { ok: true, active: true, reviewId: task.activeReviewId };
        if (task.status === "REVIEW_PENDING") {
          await this.reviewEngine?.tick?.({ reason: "manual_review_request" });
          return { ok: true, pending: true, reviewId: task.activeReviewId };
        }
        if (task.status !== "DONE_BY_WORKER") return { ok: false, reason: "task_not_reviewable", status: task.status };
        const run = this.schedulerStore.getRun(task.lastRunId);
        if (!run) return { ok: false, reason: "worker_run_missing" };
        const result = await this.reviewEngine?.enqueueForWorkerCompletion?.({ task, run, workerReport: task.workerReport || {} });
        return result || { ok: false, reason: "review_engine_unavailable" };
      });
    }

    async startIntegration() {
      if (this.recoveryStatus() !== "RUNNING") return { ok: false, reason: "integration_start_requires_running_recovery" };
      return this.integrationEngine?.tick?.({ reason: "manual_integration_request" }) || { ok: false, reason: "integration_engine_unavailable" };
    }

    async openExecutor(agentId) {
      const agent = this.registry?.getAgent?.(agentId);
      if (!agent) return { ok: false, reason: "unknown_agent" };
      if (!this.registry?.isAgentConnected?.(agent)) return { ok: false, reason: "agent_offline", agentId };
      if (typeof this.registry?.activateAgent !== "function") return { ok: false, reason: "agent_activation_unsupported", agentId };
      const result = await this.registry.activateAgent(agentId);
      return result && typeof result === "object" ? result : { ok: true, agentId };
    }
  }

  root.TaskControlService = TaskControlService;
  if (typeof module !== "undefined" && module.exports) module.exports = { TaskControlService };
})();
