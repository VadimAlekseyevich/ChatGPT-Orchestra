(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};
  const INTEGRATION_TASK_ID = "integration";
  const MAX_INTEGRATION_RUNS = 3;

  function clone(value) {
    if (typeof structuredClone === "function") return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }

  function isSha(value) { return root.GitProvider?.isCommitSha?.(value) === true; }
  function normalizePath(value) { return root.GitProvider?.normalizePath?.(value) || String(value || "").trim().replace(/\\/g, "/").replace(/^\.\//, ""); }

  function liveAgent(registry, agent) {
    if (!agent || ["OFFLINE", "ERROR"].includes(agent.status)) return false;
    if (typeof registry?.isAgentConnected === "function") return Boolean(registry.isAgentConnected(agent));
    return Number.isInteger(agent.tabId);
  }

  class IntegrationEngine {
    constructor({ store, schedulerStore, projectStore, registry, eventBus, gitProvider, sendPrompt, clock = () => Date.now(), idFactory = null, logger = console } = {}) {
      this.store = store;
      this.schedulerStore = schedulerStore;
      this.projectStore = projectStore;
      this.registry = registry;
      this.eventBus = eventBus;
      this.gitProvider = gitProvider;
      this.sendPrompt = sendPrompt;
      this.clock = clock;
      this.idFactory = idFactory || (() => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`);
      this.logger = logger;
      this.initialized = false;
      this.unsubscribers = [];
      this.tickPromise = Promise.resolve();
    }

    getPublicState() { return this.store.summary(); }

    async init() {
      if (this.initialized) return this.getPublicState();
      await this.store.load();
      if (!this.unsubscribers.length) {
        this.unsubscribers.push(this.eventBus.subscribe("lifecycle", (record) => this.handleLifecycle(record)));
        this.unsubscribers.push(this.eventBus.subscribe("progress", (record) => this.handleProgress(record)));
        this.unsubscribers.push(this.eventBus.subscribe("completion", (record) => this.handleCompletion(record)));
        this.unsubscribers.push(this.eventBus.subscribe("integration", (record) => this.handleIntegrationEvent(record)));
        this.unsubscribers.push(this.eventBus.subscribe("blocker", (record) => this.handleFailureEvent(record)));
        this.unsubscribers.push(this.eventBus.subscribe("user", (record) => this.handleFailureEvent(record)));
        this.unsubscribers.push(this.eventBus.subscribe("review", () => this.tick({ reason: "review_event" })));
      }
      await this.restoreActiveRun();
      this.initialized = true;
      await this.tick({ reason: "service_worker_init" });
      return this.getPublicState();
    }

    async restoreActiveRun() {
      const run = this.store.currentRun();
      if (!run || !["ASSIGNED", "RUNNING", "REPAIRING", "REPAIR_PENDING"].includes(run.status)) return;
      const agent = this.registry.getAgent(run.agentId);
      if (!liveAgent(this.registry, agent)) {
        await this.store.abandon(run.runId, "integrator_unavailable_after_restart");
        await this.schedulerStore.setStatus("READY_FOR_INTEGRATION");
        return;
      }
      await this.registry.setProtocolContext(run.agentId, {
        projectId: this.store.summary().projectId,
        taskId: INTEGRATION_TASK_ID,
        runId: run.runId
      });
    }

    integratorCandidates(tasks) {
      const authorCounts = new Map();
      for (const task of tasks) {
        const run = this.schedulerStore.getRun(task.lastRunId);
        if (run?.agentId) authorCounts.set(run.agentId, (authorCounts.get(run.agentId) || 0) + 1);
      }
      return this.registry.listAgents().filter((agent) => (
        agent.role === "worker"
        && liveAgent(this.registry, agent)
        && agent.status === "IDLE"
        && !agent.protocolContext
      )).sort((a, b) => (authorCounts.get(a.agentId) || 0) - (authorCounts.get(b.agentId) || 0) || a.agentId.localeCompare(b.agentId));
    }

    async ensureTargetFresh(project) {
      const snapshot = this.schedulerStore.getGitSnapshot?.();
      if (!snapshot) return { ok: false, reason: "git_base_snapshot_missing" };
      if (!this.gitProvider?.checkBaseFresh) return { ok: false, reason: "git_provider_unavailable" };
      return this.gitProvider.checkBaseFresh(project, snapshot);
    }

    buildRunSpec(project, tasks) {
      const ordered = root.IntegrationPolicy.deterministicIntegrationOrder(tasks);
      if (!ordered.ok) return ordered;
      const artifacts = root.IntegrationPolicy.approvedArtifacts(tasks, ordered.order);
      const snapshot = this.schedulerStore.getGitSnapshot?.();
      if (!snapshot?.baseSha || !snapshot?.defaultBranch) return { ok: false, reason: "git_base_snapshot_missing" };
      const runId = `integration-${this.idFactory()}`;
      return {
        ok: true,
        spec: {
          projectId: project.projectId,
          runId,
          branch: root.IntegrationPolicy.integrationBranchName(project.projectId, runId),
          baseSha: snapshot.baseSha,
          targetBranch: snapshot.defaultBranch,
          taskOrder: ordered.order,
          mergeTaskIds: artifacts.map((artifact) => artifact.taskId),
          artifacts,
          verificationCommands: root.IntegrationPolicy.verificationCommands(project, tasks)
        }
      };
    }

    async startNewRun(project, tasks) {
      if (this.store.listRuns().filter((run) => run.status === "ABANDONED").length >= MAX_INTEGRATION_RUNS) {
        return this.escalate("integration_run_budget_exhausted", { maxRuns: MAX_INTEGRATION_RUNS });
      }
      const freshness = await this.ensureTargetFresh(project);
      if (!freshness.ok) return this.escalate(freshness.reason || "integration_target_not_fresh", freshness);
      const built = this.buildRunSpec(project, tasks);
      if (!built.ok) return this.escalate(built.reason, built);
      const created = await this.store.createRun(built.spec);
      if (!created.ok) return created;
      return this.dispatchCurrent({ reason: "integration_started" });
    }

    async dispatchCurrent({ reason = "integration_dispatch" } = {}) {
      const run = this.store.currentRun();
      if (!run || run.status !== "PENDING") return { ok: false, reason: "integration_run_not_pending" };
      const tasks = this.schedulerStore.listTasks().filter((task) => task.status === "APPROVED");
      const agent = this.integratorCandidates(tasks)[0];
      if (!agent) return { ok: true, pending: true, reason: "integrator_unavailable" };
      const project = this.projectStore.getActiveProject();
      const assigned = await this.store.assign(run.runId, agent.agentId);
      if (!assigned.ok) return assigned;
      const bound = await this.registry.setProtocolContext(agent.agentId, { projectId: project.projectId, taskId: INTEGRATION_TASK_ID, runId: run.runId });
      if (!bound) {
        await this.store.abandon(run.runId, "integrator_context_bind_failed");
        await this.schedulerStore.setStatus("READY_FOR_INTEGRATION");
        return { ok: false, reason: "integrator_context_bind_failed" };
      }
      const promptRun = { ...assigned.run, projectId: project.projectId };
      const prompt = root.IntegrationPrompts.buildIntegratorPrompt({ project, run: promptRun, agentId: agent.agentId });
      const sent = await this.sendPrompt(agent.agentId, prompt);
      if (!sent?.ok) {
        await this.registry.clearProtocolContext(agent.agentId);
        await this.store.abandon(run.runId, "integration_dispatch_failed");
        await this.schedulerStore.setStatus("READY_FOR_INTEGRATION");
        return { ok: false, reason: "integration_dispatch_failed", details: sent };
      }
      await this.store.markRunning(run.runId);
      await this.schedulerStore.setStatus("INTEGRATING");
      await this.projectStore.setExecutionStatus?.(project.projectId, "INTEGRATING", {
        phase: 8,
        reason,
        integration: {
          runId: run.runId,
          agentId: agent.agentId,
          branch: run.branch,
          baseSha: run.baseSha,
          targetBranch: run.targetBranch,
          mergeOrder: run.mergeTaskIds,
          targetPolicy: this.store.summary().settings.targetPolicy
        }
      });
      await this.schedulerStore.logDecision("integration_assigned", {
        runId: run.runId,
        agentId: agent.agentId,
        branch: run.branch,
        mergeOrder: run.mergeTaskIds,
        targetPolicy: this.store.summary().settings.targetPolicy
      });
      return { ok: true, run: this.store.currentRun() };
    }

    async tick({ reason = "integration_tick" } = {}) {
      this.tickPromise = this.tickPromise.catch(() => {}).then(async () => {
        if (this.store.summary().status === "INTEGRATION_VERIFIED" || this.store.summary().status === "NEEDS_USER") return { ok: true, terminal: true };
        await this.checkWatchdog();
        if (this.store.summary().status === "NEEDS_USER") return { ok: false, reason: "integration_needs_user" };
        const current = this.store.currentRun();
        if (current) {
          if (current.status === "PENDING") return this.dispatchCurrent({ reason });
          if (["ASSIGNED", "RUNNING", "REPAIRING", "REPAIR_PENDING", "CONFLICT"].includes(current.status)) return { ok: true, active: true, run: current };
        }
        if (this.schedulerStore.summary().status !== "READY_FOR_INTEGRATION") return { ok: true, waiting: true };
        const tasks = this.schedulerStore.listTasks().filter((task) => task.status !== "CANCELLED");
        if (!tasks.length || tasks.some((task) => task.status !== "APPROVED")) return { ok: true, waiting: true, reason: "tasks_not_all_approved" };
        const project = this.projectStore.getActiveProject();
        if (!project) return { ok: false, reason: "no_active_project" };
        await this.store.ensureProject(project.projectId);
        return this.startNewRun(project, tasks);
      });
      return this.tickPromise;
    }

    matchesRun(record) {
      const event = record?.event;
      const run = this.store.currentRun();
      if (!event || !run) return null;
      if (event.projectId !== this.store.summary().projectId || event.taskId !== INTEGRATION_TASK_ID) return null;
      if (event.runId !== run.runId || event.agentId !== run.agentId) return null;
      if (!["ASSIGNED", "RUNNING", "CONFLICT", "REPAIR_PENDING", "REPAIRING"].includes(run.status)) return null;
      return run;
    }

    async handleLifecycle(record) {
      const run = this.matchesRun(record);
      if (!run) return;
      if (["TASK_ACCEPTED", "HEARTBEAT", "READY"].includes(record.event.event)) await this.store.touch(run.runId);
    }

    async handleProgress(record) {
      const run = this.matchesRun(record);
      if (!run || record.event.event !== "PROGRESS") return;
      await this.store.touch(run.runId);
    }

    async handleIntegrationEvent(record) {
      const run = this.matchesRun(record);
      if (!run) return;
      if (record.event.event === "CONFLICT_RESOLVED") {
        await this.escalate("unexpected_conflict_resolved_event", { runId: run.runId, payload: record.event.payload || {} });
        return;
      }
      if (record.event.event !== "CONFLICT") return;
      const normalized = root.IntegrationPolicy.normalizeConflictPayload(record.event.payload || {}, run.taskOrder);
      if (!normalized.ok) return this.escalate(normalized.reason, normalized);
      const progress = root.IntegrationPolicy.validateMergeProgress(normalized.conflict, run.mergeTaskIds);
      if (!progress.ok) return this.escalate(progress.reason, progress);
      const tasks = this.schedulerStore.listTasks().filter((task) => task.status === "APPROVED");
      const responsibleTaskIds = root.IntegrationPolicy.identifyResponsibleTasks(normalized.conflict, tasks, run.taskOrder);
      if (!responsibleTaskIds.length) return this.escalate("integration_conflict_responsibility_unknown", normalized.conflict);
      if (normalized.conflict.conflictType === "semantic" && !normalized.conflict.responsibleTaskIds.length) {
        return this.escalate("semantic_conflict_requires_explicit_responsibility", { conflict: normalized.conflict, inferred: responsibleTaskIds });
      }
      if (run.activeRepairTaskId) await this.store.finishRepair(run.activeRepairTaskId, { outcome: "conflict_recurred", eventId: record.event.eventId });
      await this.store.recordConflict(run.runId, normalized.conflict, responsibleTaskIds);
      await this.schedulerStore.logDecision("integration_conflict", {
        runId: run.runId,
        conflictType: normalized.conflict.conflictType,
        responsibleTaskIds,
        files: normalized.conflict.files,
        failedChecks: normalized.conflict.failedChecks
      });
      const repair = await this.store.createRepairTask(run.runId, {
        conflict: normalized.conflict,
        responsibleTaskIds,
        nextSequence: Number(record.event.sequence) + 1
      });
      if (!repair.ok) return this.escalate(repair.reason, { conflict: normalized.conflict, responsibleTaskIds });
      const project = this.projectStore.getActiveProject();
      const promptRun = { ...repair.run, projectId: project.projectId };
      const prompt = root.IntegrationPrompts.buildRepairPrompt({ project, run: promptRun, repairTask: repair.repairTask, agentId: run.agentId });
      const sent = await this.sendPrompt(run.agentId, prompt);
      if (!sent?.ok) {
        await this.registry.clearProtocolContext(run.agentId);
        await this.store.abandon(run.runId, "integration_repair_dispatch_failed");
        await this.schedulerStore.setStatus("READY_FOR_INTEGRATION");
        await this.projectStore.setExecutionStatus?.(project.projectId, "READY_FOR_INTEGRATION", { phase: 8, reason: "integration_repair_dispatch_failed" });
        return this.tick({ reason: "repair_dispatch_retry_new_run" });
      }
      await this.store.markRepairActive(repair.repairTask.repairTaskId);
      await this.projectStore.setExecutionStatus?.(project.projectId, "INTEGRATION_REPAIRING", {
        phase: 8,
        integration: { runId: run.runId, branch: run.branch },
        repairTask: repair.repairTask
      });
    }

    async handleCompletion(record) {
      const run = this.matchesRun(record);
      if (!run || record.event.event !== "DONE") return;
      const normalized = root.IntegrationPolicy.validateDonePayload(record.event.payload || {}, run);
      if (!normalized.ok) return this.escalate(normalized.reason, normalized);
      const validation = await this.validateRemoteIntegration(run, normalized.result);
      if (!validation.ok) return this.escalate(validation.reason || "integration_artifact_invalid", validation);
      if (run.activeRepairTaskId) await this.store.finishRepair(run.activeRepairTaskId, { outcome: "resolved", eventId: record.event.eventId });
      await this.registry.clearProtocolContext(run.agentId);
      const result = {
        ...normalized.result,
        verifiedAt: this.clock(),
        targetPolicy: this.store.summary().settings.targetPolicy,
        targetBranchUnmodified: true,
        remoteValidation: validation.summary
      };
      await this.store.complete(run.runId, result);
      await this.schedulerStore.setStatus("INTEGRATION_VERIFIED");
      const projectId = this.store.summary().projectId;
      await this.projectStore.setExecutionStatus?.(projectId, "INTEGRATION_VERIFIED", { phase: 8, integration: result });
      await this.schedulerStore.logDecision("integration_verified", {
        runId: run.runId,
        branch: result.branch,
        commit: result.commit,
        mergeOrder: result.mergedTaskIds,
        targetPolicy: result.targetPolicy
      });
    }

    async handleFailureEvent(record) {
      const run = this.matchesRun(record);
      if (!run || !["BLOCKED", "ERROR", "NEEDS_USER"].includes(record.event.event)) return;
      await this.registry.clearProtocolContext(run.agentId);
      await this.escalate(`integrator_${record.event.event.toLowerCase()}`, record.event.payload || {});
    }

    async validateRemoteIntegration(run, result) {
      if (!isSha(result.commit) || !isSha(result.baseSha)) return { ok: false, reason: "integration_commit_sha_invalid" };
      if (result.branch !== run.branch) return { ok: false, reason: "integration_branch_mismatch", expected: run.branch, received: result.branch };
      if (result.baseSha !== String(run.baseSha).toLowerCase()) return { ok: false, reason: "integration_base_mismatch" };
      if (result.targetBranch !== run.targetBranch) return { ok: false, reason: "integration_target_branch_mismatch" };
      const project = this.projectStore.getActiveProject();
      const freshness = await this.ensureTargetFresh(project);
      if (!freshness.ok) return freshness;
      const branchHead = await this.gitProvider.getBranchHead(project, run.branch);
      if (!branchHead.ok) return { ...branchHead, reason: branchHead.reason === "git_repository_or_ref_unavailable" ? "integration_branch_missing" : branchHead.reason };
      if (branchHead.sha !== result.commit) return { ok: false, reason: "integration_branch_head_mismatch", expected: result.commit, actual: branchHead.sha };
      const compared = await this.gitProvider.compare(project, run.baseSha, result.commit);
      if (!compared.ok) return compared;
      const comparison = compared.comparison || {};
      const mergeBase = String(comparison?.merge_base_commit?.sha || "").toLowerCase();
      if (mergeBase !== String(run.baseSha).toLowerCase()) return { ok: false, reason: "integration_not_based_on_snapshot", mergeBase };
      if ((Number(comparison.behind_by) || 0) !== 0) return { ok: false, reason: "integration_branch_behind_base", behindBy: Number(comparison.behind_by) || 0 };
      if (run.artifacts.length && (Number(comparison.ahead_by) || 0) < 1) return { ok: false, reason: "integration_branch_has_no_merged_commits" };

      const actualFiles = [...new Set((Array.isArray(comparison.files) ? comparison.files : []).map((file) => normalizePath(file?.filename)).filter(Boolean))].sort();
      if (actualFiles.length >= 300) return { ok: false, reason: "integration_changed_files_may_be_truncated", changedFileCount: actualFiles.length };
      if (JSON.stringify(actualFiles) !== JSON.stringify(result.changedFiles)) {
        return { ok: false, reason: "integration_reported_changed_files_mismatch", reported: result.changedFiles, actual: actualFiles };
      }
      const allowedFiles = new Set(run.artifacts.flatMap((artifact) => artifact.changedFiles || []).map(normalizePath));
      const unexpectedFiles = actualFiles.filter((file) => !allowedFiles.has(file));
      if (unexpectedFiles.length) return { ok: false, reason: "integration_changed_file_outside_approved_artifacts", unexpectedFiles };

      for (const artifact of run.artifacts) {
        const ancestry = await this.gitProvider.compare(project, artifact.commit, result.commit);
        if (!ancestry.ok) return { ...ancestry, reason: ancestry.reason || "integration_ancestry_check_failed", taskId: artifact.taskId };
        const ancestorBase = String(ancestry.comparison?.merge_base_commit?.sha || "").toLowerCase();
        if (ancestorBase !== artifact.commit || (Number(ancestry.comparison?.behind_by) || 0) !== 0) {
          return { ok: false, reason: "approved_commit_not_ancestor_of_integration", taskId: artifact.taskId, commit: artifact.commit, mergeBase: ancestorBase };
        }
      }

      const history = await this.verifyMergeHistory(project, run, result.commit);
      if (!history.ok) return history;
      return {
        ok: true,
        summary: {
          baseSha: run.baseSha,
          integrationHead: result.commit,
          aheadBy: Number(comparison.ahead_by) || 0,
          changedFiles: actualFiles,
          verifiedTaskCommits: run.artifacts.map((artifact) => ({ taskId: artifact.taskId, commit: artifact.commit })),
          firstParentMergeOrder: history.taskIds
        }
      };
    }

    async getCommit(project, sha) {
      const owner = String(project?.repository?.owner || "");
      const repo = String(project?.repository?.repo || "");
      if (!owner || !repo || !isSha(sha) || !this.gitProvider?.request) return { ok: false, reason: "integration_commit_lookup_unavailable" };
      const result = await this.gitProvider.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/commits/${sha}`);
      if (!result.ok) return result;
      return { ok: true, commit: result.data };
    }

    async verifyMergeHistory(project, run, headSha) {
      const expected = run.artifacts.map((artifact) => artifact.commit);
      const taskByCommit = new Map(run.artifacts.map((artifact) => [artifact.commit, artifact.taskId]));
      const reverseFound = [];
      let current = headSha;
      const maxSteps = Math.max(24, expected.length * 4 + 16);
      for (let step = 0; step < maxSteps && current !== run.baseSha; step += 1) {
        const lookedUp = await this.getCommit(project, current);
        if (!lookedUp.ok) return { ...lookedUp, reason: lookedUp.reason || "integration_history_lookup_failed", commit: current };
        const parents = Array.isArray(lookedUp.commit?.parents) ? lookedUp.commit.parents.map((item) => String(item?.sha || "").toLowerCase()).filter(isSha) : [];
        if (!parents.length) return { ok: false, reason: "integration_history_did_not_reach_base", commit: current };
        if (parents.length > 1 && taskByCommit.has(parents[1])) reverseFound.push(parents[1]);
        current = parents[0];
      }
      if (current !== run.baseSha) return { ok: false, reason: "integration_history_depth_exceeded", current, expectedBase: run.baseSha };
      const found = reverseFound.reverse();
      if (JSON.stringify(found) !== JSON.stringify(expected)) {
        return {
          ok: false,
          reason: "integration_merge_history_order_mismatch",
          expectedTaskIds: run.artifacts.map((artifact) => artifact.taskId),
          actualTaskIds: found.map((commit) => taskByCommit.get(commit) || commit)
        };
      }
      return { ok: true, taskIds: found.map((commit) => taskByCommit.get(commit)) };
    }

    async checkWatchdog() {
      const run = this.store.currentRun();
      if (!run || !["ASSIGNED", "RUNNING", "REPAIRING", "REPAIR_PENDING", "CONFLICT"].includes(run.status)) return;
      const agentHeartbeat = Number(this.registry.getAgent(run.agentId)?.lastSeenAt) || 0;
      const reference = Math.max(Number(run.lastEventAt) || 0, Number(run.startedAt) || 0, Number(run.assignedAt) || 0, agentHeartbeat);
      if (!reference || this.clock() - reference < this.store.summary().settings.runTimeoutMs) return;
      await this.registry.clearProtocolContext(run.agentId);
      await this.store.abandon(run.runId, "integration_timeout");
      await this.schedulerStore.setStatus("READY_FOR_INTEGRATION");
      const projectId = this.store.summary().projectId;
      await this.projectStore.setExecutionStatus?.(projectId, "READY_FOR_INTEGRATION", { phase: 8, reason: "integration_timeout_retry" });
    }

    async handleAgentUnavailable(agentId, reason = "integrator_unavailable") {
      const run = this.store.currentRun();
      if (!run || run.agentId !== agentId || !["ASSIGNED", "RUNNING", "REPAIRING", "REPAIR_PENDING", "CONFLICT"].includes(run.status)) return { ok: true, ignored: true };
      await this.registry.clearProtocolContext(agentId);
      await this.store.abandon(run.runId, reason);
      await this.schedulerStore.setStatus("READY_FOR_INTEGRATION");
      const projectId = this.store.summary().projectId;
      await this.projectStore.setExecutionStatus?.(projectId, "READY_FOR_INTEGRATION", { phase: 8, reason, abandonedRunId: run.runId });
      await this.tick({ reason: "integrator_unavailable" });
      return { ok: true, handled: true };
    }

    async handleAgentStateChanged(agent) {
      if (agent?.role === "worker" && agent.status === "IDLE") await this.tick({ reason: "worker_idle_for_integration" });
    }

    async escalate(reason, details = null) {
      const run = this.store.currentRun();
      if (run?.agentId) await this.registry.clearProtocolContext(run.agentId);
      await this.store.fail(run?.runId || null, reason, details);
      await this.schedulerStore.setStatus("NEEDS_USER");
      const projectId = this.store.summary().projectId || this.projectStore.getActiveProject()?.projectId;
      if (projectId) await this.projectStore.setExecutionStatus?.(projectId, "NEEDS_USER", { phase: 8, reason, details });
      await this.schedulerStore.logDecision("needs_user", { phase: 8, reason, details });
      return { ok: false, reason, details };
    }
  }

  root.IntegrationEngine = IntegrationEngine;
  root.INTEGRATION_TASK_ID = INTEGRATION_TASK_ID;
  root.PHASE8_MAX_INTEGRATION_RUNS = MAX_INTEGRATION_RUNS;
  if (typeof module !== "undefined" && module.exports) module.exports = { IntegrationEngine, INTEGRATION_TASK_ID, MAX_INTEGRATION_RUNS };
})();
