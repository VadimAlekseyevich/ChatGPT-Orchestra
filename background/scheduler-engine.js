(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};
  const TERMINAL_SUCCESS = "APPROVED";
  const GIT_FRESHNESS_TTL_MS = 2 * 60 * 1000;
  const FATAL_GIT_REASONS = new Set([
    "target_branch_moved",
    "git_provider_auth_required",
    "git_provider_rate_limited",
    "git_provider_network_error",
    "git_provider_unavailable",
    "git_repository_identity_missing",
    "git_repository_or_ref_unavailable",
    "git_default_branch_missing",
    "git_base_snapshot_missing",
    "git_changed_files_may_be_truncated"
  ]);

  function riskRank(value) {
    const normalized = String(value || "medium").toLowerCase();
    return ({ low: 0, medium: 1, high: 2, critical: 3 })[normalized] ?? 1;
  }

  function liveAgent(registry, agent) {
    if (!agent || ["OFFLINE", "ERROR"].includes(agent.status)) return false;
    if (typeof registry?.isAgentConnected === "function") return Boolean(registry.isAgentConnected(agent));
    return Number.isInteger(agent.tabId);
  }

  class SchedulerEngine {
    constructor({ store, projectStore, registry, eventBus, gitProvider = null, reviewEngine = null, sendPrompt, clock = () => Date.now(), idFactory = null, logger = console } = {}) {
      this.store = store;
      this.projectStore = projectStore;
      this.registry = registry;
      this.eventBus = eventBus;
      this.gitProvider = gitProvider;
      this.reviewEngine = reviewEngine;
      this.sendPrompt = sendPrompt;
      this.clock = clock;
      this.idFactory = idFactory || (() => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`);
      this.logger = logger;
      this.initialized = false;
      this.unsubscribers = [];
      this.tickPromise = Promise.resolve();
    }

    getPublicState() {
      return { ...this.store.summary(), review: this.reviewEngine?.getPublicState?.() || null };
    }
    getRecentDecisions(limit) { return this.store.recentDecisions(limit); }

    async init() {
      if (this.initialized) return this.getPublicState();
      await this.store.load();
      if (this.reviewEngine) await this.reviewEngine.init();
      if (!this.unsubscribers.length) {
        this.unsubscribers.push(this.eventBus.subscribe("lifecycle", (record) => this.handleLifecycle(record)));
        this.unsubscribers.push(this.eventBus.subscribe("progress", (record) => this.handleProgress(record)));
        this.unsubscribers.push(this.eventBus.subscribe("completion", (record) => this.handleCompletion(record)));
        this.unsubscribers.push(this.eventBus.subscribe("blocker", (record) => this.handleBlocker(record)));
        this.unsubscribers.push(this.eventBus.subscribe("user", (record) => this.handleNeedsUser(record)));
      }
      await this.restoreActiveContexts();
      this.initialized = true;
      if (this.store.summary().status === "RUNNING") {
        const project = this.projectStore.getActiveProject();
        if (project?.status === "COMPLETED_UNVERIFIED") {
          await this.projectStore.setExecutionStatus?.(project.projectId, "RUNNING", { phase: 7, upgradeFrom: "COMPLETED_UNVERIFIED" });
        }
        await this.reviewEngine?.recoverReviewableTasks?.();
        await this.tick({ reason: "service_worker_init" });
      }
      return this.getPublicState();
    }

    async restoreActiveContexts() {
      for (const run of this.store.activeRuns()) {
        const agent = this.registry.getAgent(run.agentId);
        if (!liveAgent(this.registry, agent)) {
          const result = await this.store.markFailure(run.runId, "agent_unavailable_after_restart", { retryable: true });
          await this.store.logDecision("recovered_agent_unavailable", { runId: run.runId, taskId: run.taskId, agentId: run.agentId });
          if (result?.task?.status === "NEEDS_USER") {
            await this.escalate("restart_retries_exhausted", result.task);
            break;
          }
          continue;
        }
        await this.registry.setProtocolContext(run.agentId, {
          projectId: this.store.summary().projectId,
          taskId: run.taskId,
          runId: run.runId
        });
      }
    }

    async ensureGitSnapshot(project) {
      const existing = this.store.getGitSnapshot?.();
      if (existing?.baseSha && existing?.defaultBranch) return { ok: true, snapshot: existing, reused: true };
      if (!this.gitProvider?.captureBase) return { ok: false, reason: "git_provider_unavailable" };
      const captured = await this.gitProvider.captureBase(project);
      if (!captured.ok) return captured;
      await this.store.setGitSnapshot(captured.snapshot);
      await this.store.logDecision("git_base_captured", {
        provider: captured.snapshot.provider,
        targetBranch: captured.snapshot.defaultBranch,
        baseSha: captured.snapshot.baseSha
      });
      return { ok: true, snapshot: this.store.getGitSnapshot?.() || captured.snapshot, reused: false };
    }

    async ensureBaseFresh({ force = false } = {}) {
      const project = this.projectStore.getActiveProject();
      const snapshot = this.store.getGitSnapshot?.();
      if (!project || !snapshot) return { ok: false, reason: "git_base_snapshot_missing" };
      if (!this.gitProvider?.checkBaseFresh) return { ok: false, reason: "git_provider_unavailable" };
      const lastCheckedAt = Number(snapshot.lastCheckedAt) || 0;
      if (!force && lastCheckedAt && this.clock() - lastCheckedAt < GIT_FRESHNESS_TTL_MS) {
        const cachedStatus = String(snapshot.lastFreshnessStatus || "fresh");
        if (cachedStatus === "fresh") return { ok: true, cached: true, currentTargetSha: snapshot.currentTargetSha || snapshot.baseSha };
        return { ok: false, reason: cachedStatus, cached: true, currentTargetSha: snapshot.currentTargetSha || null };
      }
      const result = await this.gitProvider.checkBaseFresh(project, snapshot);
      await this.store.recordGitFreshness?.(result);
      if (!result.ok) {
        await this.store.logDecision("git_base_not_fresh", { reason: result.reason, result });
        await this.escalate(result.reason || "git_base_not_fresh", null, result);
      }
      return result;
    }

    async start({ maxWorkers = 4, maxRetries = 2, runTimeoutMs = null, maxReviewIterations = 3 } = {}) {
      const project = this.projectStore.getActiveProject();
      if (!project) return { ok: false, reason: "no_active_project" };
      if (!project.taskGraph?.tasks?.length) return { ok: false, reason: "project_task_graph_missing" };
      if (!["READY", "RUNNING"].includes(project.status)) return { ok: false, reason: "project_not_ready_for_execution", status: project.status };

      const current = this.store.summary();
      if (current.projectId !== project.projectId || current.taskCount === 0) {
        const captured = this.gitProvider?.captureBase ? await this.gitProvider.captureBase(project) : { ok: false, reason: "git_provider_unavailable" };
        if (!captured.ok) return { ok: false, reason: captured.reason || "git_base_capture_failed", git: captured };
        const initialized = await this.store.initializeProject(project, {
          maxWorkers,
          maxRetries,
          runTimeoutMs: runTimeoutMs || root.SCHEDULER_DEFAULTS?.runTimeoutMs
        });
        if (!initialized.ok) return initialized;
        await this.store.setGitSnapshot(captured.snapshot);
        await this.store.logDecision("git_base_captured", {
          provider: captured.snapshot.provider,
          targetBranch: captured.snapshot.defaultBranch,
          baseSha: captured.snapshot.baseSha
        });
      } else {
        if (current.status === "READY_FOR_INTEGRATION") return { ok: false, reason: "scheduler_already_reviewed" };
        if (current.status === "NEEDS_USER") return { ok: false, reason: "scheduler_needs_user" };
        const snapshot = await this.ensureGitSnapshot(project);
        if (!snapshot.ok) return { ok: false, reason: snapshot.reason || "git_base_capture_failed", git: snapshot };
        await this.store.setSettings({ maxWorkers, maxRetries, ...(runTimeoutMs ? { runTimeoutMs } : {}) });
        await this.store.setStatus("RUNNING");
      }

      await this.reviewEngine?.configureProject?.(project.projectId, { maxReviewIterations });
      const git = this.store.getGitSnapshot?.();
      await this.projectStore.setExecutionStatus?.(project.projectId, "RUNNING", {
        phase: 7,
        git: git ? { provider: git.provider, targetBranch: git.defaultBranch, baseSha: git.baseSha } : null,
        review: { maxReviewIterations: Math.max(1, Number(maxReviewIterations) || 3) }
      });
      await this.store.logDecision("scheduler_started", { settings: this.store.summary().settings, phase: 7, maxReviewIterations });
      await this.tick({ reason: "start_execution" });
      return { ok: true, scheduler: this.getPublicState() };
    }

    downstreamCount(taskId) {
      const tasks = this.store.listTasks();
      const direct = new Map(tasks.map((task) => [task.id, []]));
      for (const task of tasks) for (const dependency of task.dependencies || []) direct.get(dependency)?.push(task.id);
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
      for (const agentId of this.reviewEngine?.activeReviewerAgentIds?.() || []) activeAgentIds.add(agentId);
      return this.registry.listAgents().filter((agent) => (
        agent.role === "worker"
        && liveAgent(this.registry, agent)
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

    gitAssignment(project, task, runId) {
      const snapshot = this.store.getGitSnapshot?.();
      const definition = task.definition || task;
      const required = root.GitProvider?.requiresGitArtifact?.(definition) !== false;
      const startSha = task.reworkContext?.previousCommit || snapshot?.baseSha || "";
      if (!snapshot) return { required, provider: "", branch: "", targetBranch: "", baseSha: "", startSha };
      return {
        required,
        provider: snapshot.provider,
        branch: required ? this.gitProvider.branchName(project.projectId, task.id, runId) : "",
        targetBranch: snapshot.defaultBranch,
        baseSha: snapshot.baseSha,
        startSha,
        cleanupPolicy: snapshot.cleanupPolicy || root.GitProvider?.CLEANUP_POLICY || "retain_until_review_or_manual_cleanup"
      };
    }

    async dispatch(task, agent) {
      const project = this.projectStore.getActiveProject();
      if (!project || project.projectId !== this.store.summary().projectId) return { ok: false, reason: "project_context_changed" };
      const runId = `run-${this.idFactory()}`;
      const locks = root.SchedulerConflictPolicy.resourceKeys(task);
      const git = this.gitAssignment(project, task, runId);
      const created = await this.store.createRun({ taskId: task.id, runId, agentId: agent.agentId, locks, git });
      if (!created.ok) return created;

      const bound = await this.registry.setProtocolContext(agent.agentId, { projectId: project.projectId, taskId: task.id, runId });
      if (!bound) {
        await this.store.markFailure(runId, "agent_context_bind_failed", { retryable: true });
        return { ok: false, reason: "agent_context_bind_failed" };
      }
      const definition = task.definition || task;
      const prompt = root.WorkerPrompts.buildWorkerPrompt({
        project,
        task: definition,
        runId,
        agentId: agent.agentId,
        gitAssignment: git,
        reworkContext: task.reworkContext || null
      });
      const result = await this.sendPrompt(agent.agentId, prompt);
      if (!result?.ok) {
        const failed = await this.store.markFailure(runId, "dispatch_failed", { retryable: true });
        await this.registry.clearProtocolContext(agent.agentId);
        await this.store.logDecision("dispatch_failed", { taskId: task.id, runId, agentId: agent.agentId, branch: git.branch || null, result });
        if (failed?.task?.status === "NEEDS_USER") await this.escalate("dispatch_retries_exhausted", failed.task);
        return { ok: false, reason: "dispatch_failed", details: result };
      }

      await this.store.logDecision("task_assigned", {
        taskId: task.id,
        runId,
        agentId: agent.agentId,
        locks,
        branch: git.branch || null,
        targetBranch: git.targetBranch || null,
        baseSha: git.baseSha || null,
        startSha: git.startSha || null,
        rework: Boolean(task.reworkContext),
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

      await this.reviewEngine?.tick?.({ reason: `scheduler:${reason}` });
      if (this.store.summary().status !== "RUNNING") return { ok: false, reason: "scheduler_stopped_by_review", scheduler: this.getPublicState() };

      const maxWorkers = this.store.summary().settings.maxWorkers;
      let workers = this.availableWorkers();
      let active = this.activeTasks();
      const reviewActive = Number(this.reviewEngine?.activeCount?.()) || 0;
      let capacity = Math.max(0, maxWorkers - this.store.activeRuns().length - reviewActive);
      let candidates = this.sortCandidates(this.store.runnableTasks());
      const assigned = [];

      if (capacity > 0 && workers.length && candidates.length) {
        const freshness = await this.ensureBaseFresh();
        if (!freshness.ok) return { ok: false, reason: freshness.reason || "git_base_not_fresh", scheduler: this.getPublicState() };
      }

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
        await this.store.setStatus("READY_FOR_INTEGRATION");
        const projectId = this.store.summary().projectId;
        const git = this.store.getGitSnapshot?.();
        await this.projectStore.setExecutionStatus?.(projectId, "READY_FOR_INTEGRATION", {
          phase: 7,
          git: git ? { provider: git.provider, targetBranch: git.defaultBranch, baseSha: git.baseSha } : null,
          review: this.reviewEngine?.getPublicState?.() || null
        });
        await this.store.logDecision("review_phase_completed", { policy: TERMINAL_SUCCESS, nextPhase: "integration" });
      } else if (!assigned.length && !this.store.activeRuns().length && !this.store.runnableTasks().length) {
        const reviewState = this.reviewEngine?.getPublicState?.();
        if (reviewState?.pending || reviewState?.active) {
          await this.store.logDecision("scheduler_waiting_for_review", { trigger: reason, review: reviewState });
        } else {
          await this.store.logDecision("scheduler_stalled", {
            trigger: reason,
            unfinished: this.store.listTasks().filter((task) => ![TERMINAL_SUCCESS, "CANCELLED"].includes(task.status)).map((task) => ({ id: task.id, status: task.status }))
          });
        }
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
      const task = this.store.getTask(run.taskId);
      const project = this.projectStore.getActiveProject();
      const definition = task?.definition || task;

      if (run.git?.required !== false) {
        const validation = this.gitProvider?.validateArtifact
          ? await this.gitProvider.validateArtifact({ project, task: definition, run, snapshot: this.store.getGitSnapshot?.(), payload: record.event.payload || {} })
          : { ok: false, reason: "git_provider_unavailable" };
        await this.store.recordArtifactValidation?.(run.runId, validation);

        if (!validation.ok) {
          const gitReason = String(validation.reason || "artifact_invalid");
          const fatal = FATAL_GIT_REASONS.has(gitReason) || gitReason.startsWith("git_provider_");
          const result = await this.store.markFailure(run.runId, "artifact_invalid", { retryable: !fatal, needsUser: fatal });
          await this.registry.clearProtocolContext(run.agentId);
          await this.store.logDecision("git_artifact_invalid", {
            taskId: run.taskId,
            runId: run.runId,
            agentId: run.agentId,
            branch: run.git?.branch || null,
            reason: gitReason,
            fatal,
            validation
          });
          if (fatal || result?.task?.status === "NEEDS_USER") await this.escalate(gitReason, result?.task || task, validation);
          else await this.tick({ reason: "artifact_invalid_retry" });
          return;
        }

        await this.store.logDecision("git_artifact_valid", {
          taskId: run.taskId,
          runId: run.runId,
          agentId: run.agentId,
          branch: validation.artifact?.branch,
          commit: validation.artifact?.commit,
          changedFiles: validation.artifact?.changedFiles || []
        });
      }

      const done = await this.store.markDone(run.runId, record.event.payload || {});
      if (!done || done.ok === false) {
        await this.escalate(done?.reason || "task_completion_persistence_failed", task, done || null);
        return;
      }
      await this.registry.clearProtocolContext(run.agentId);
      await this.store.logDecision("task_done_by_worker", {
        taskId: run.taskId,
        runId: run.runId,
        agentId: run.agentId,
        artifact: done.task?.lastArtifact || null
      });

      if (!this.reviewEngine) {
        await this.escalate("review_engine_unavailable", done.task);
        return;
      }
      const queued = await this.reviewEngine.enqueueForWorkerCompletion({ task: done.task, run: done.run, workerReport: record.event.payload || {} });
      if (!queued?.ok) {
        await this.escalate(queued?.reason || "review_enqueue_failed", done.task, queued || null);
        return;
      }
      await this.tick({ reason: "worker_done_review_queued" });
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
        branch: run.git?.branch || null,
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

    async escalate(reason, task, details = null) {
      await this.store.setStatus("NEEDS_USER");
      const projectId = this.store.summary().projectId;
      await this.projectStore.setExecutionStatus?.(projectId, "NEEDS_USER", {
        phase: 7,
        reason,
        taskId: task?.id || null,
        details
      });
      await this.store.logDecision("needs_user", { phase: 7, reason, taskId: task?.id || null, details });
    }

    async checkWatchdog() {
      const now = this.clock();
      const timeout = this.store.summary().settings.runTimeoutMs;
      for (const run of this.store.activeRuns()) {
        const agentHeartbeat = Number(this.registry.getAgent(run.agentId)?.lastSeenAt) || 0;
        const reference = Math.max(Number(run.lastEventAt) || 0, Number(run.startedAt) || 0, Number(run.assignedAt) || 0, agentHeartbeat);
        if (!reference || now - reference < timeout) continue;
        const result = await this.store.markFailure(run.runId, "timeout", { retryable: true });
        await this.registry.clearProtocolContext(run.agentId);
        await this.store.logDecision("run_timeout", { taskId: run.taskId, runId: run.runId, agentId: run.agentId, branch: run.git?.branch || null, timeoutMs: timeout });
        if (result?.task?.status === "NEEDS_USER") {
          await this.escalate("watchdog_retries_exhausted", result.task);
          break;
        }
      }
    }

    async handleAgentUnavailable(agentId, reason = "agent_unavailable") {
      const reviewResult = await this.reviewEngine?.handleAgentUnavailable?.(agentId, reason);
      if (reviewResult?.handled) {
        await this.tick({ reason: "reviewer_unavailable" });
        return { ok: true, reviewHandled: true };
      }
      const run = this.store.activeRuns().find((item) => item.agentId === agentId);
      if (!run) return { ok: true, ignored: true };
      const result = await this.store.markFailure(run.runId, reason, { retryable: true });
      await this.registry.clearProtocolContext(agentId);
      await this.store.logDecision("agent_unavailable", { agentId, runId: run.runId, taskId: run.taskId, branch: run.git?.branch || null, reason });
      if (result?.task?.status === "NEEDS_USER") await this.escalate("agent_retries_exhausted", result.task);
      else await this.tick({ reason: "agent_unavailable" });
      return { ok: true };
    }

    async handleAgentStateChanged(agent) {
      if (this.store.summary().status !== "RUNNING") return;
      await this.reviewEngine?.handleAgentStateChanged?.(agent);
      if (agent?.role === "worker" && agent.status === "IDLE") await this.tick({ reason: "worker_idle" });
    }
  }

  root.SchedulerEngine = SchedulerEngine;
  root.PHASE7_DEPENDENCY_SUCCESS = TERMINAL_SUCCESS;
  root.PHASE6_GIT_FRESHNESS_TTL_MS = GIT_FRESHNESS_TTL_MS;

  if (typeof module !== "undefined" && module.exports) module.exports = { SchedulerEngine, TERMINAL_SUCCESS, GIT_FRESHNESS_TTL_MS, FATAL_GIT_REASONS, riskRank };
})();