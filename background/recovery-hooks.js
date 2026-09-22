(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};
  if (root.__recoveryHooksInstalled) return;
  root.__recoveryHooksInstalled = true;

  const NEXT_PLANNING_STAGE = Object.freeze({
    DISCOVERY: "PLAN_V1",
    PLAN_V1: "CRITIQUE",
    CRITIQUE: "PLAN_V2",
    PLAN_V2: "DECOMPOSE",
    DECOMPOSE: "DAG_CRITIC"
  });

  function controller() { return root.RecoveryRuntime?.controller || null; }
  function canDispatch() { return controller()?.canDispatchNewPrompts?.() !== false; }
  function recovering() { return controller()?.isRecovering?.() === true; }
  function liveAgent(registry, agent) {
    if (!agent || ["OFFLINE", "ERROR"].includes(agent.status)) return false;
    if (typeof registry?.isAgentConnected === "function") return Boolean(registry.isAgentConnected(agent));
    return Number.isInteger(agent.tabId);
  }
  function clone(value) {
    if (typeof structuredClone === "function") return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }

  if (root.ProjectStore?.prototype && !root.ProjectStore.prototype.interruptStage) {
    root.ProjectStore.prototype.interruptStage = async function interruptStage(projectId, reason = "interrupted") {
      const project = this.state?.projects?.[projectId];
      if (!project || project.status !== "PLANNING") return null;
      const runId = project.currentRunId;
      if (runId) {
        const already = project.stageHistory.some((entry) => entry.stage === project.stage && entry.runId === runId && entry.status === "interrupted");
        if (!already) project.stageHistory.push({ stage: project.stage, runId, status: "interrupted", reason, at: this.clock() });
      }
      project.currentRunId = null;
      project.updatedAt = this.clock();
      await this.persist();
      return this.getProject(projectId);
    };
  }

  if (root.SchedulerStore?.prototype && !root.SchedulerStore.prototype.markInterrupted) {
    root.SchedulerStore.prototype.markInterrupted = async function markInterrupted(runId, reason = "interrupted", options = {}) {
      const run = this.state?.runs?.[runId];
      if (!run) return null;
      const task = this.state.tasks?.[run.taskId];
      const now = this.clock();
      run.status = "INTERRUPTED";
      run.failureReason = String(reason || "interrupted");
      run.lastEventAt = now;
      run.finishedAt = now;
      if (task) {
        task.activeRunId = null;
        if (task.status !== "APPROVED") task.status = "READY";
        task.lastError = { reason: run.failureReason, at: now, recovery: true };
        if (options.refundAttempt !== false) task.attempts = Math.max(0, Number(task.attempts) - 1);
        if (options.recoveredProgress?.commit) {
          const progress = options.recoveredProgress;
          task.reworkContext = {
            sourceReviewId: null,
            sourceWorkerRunId: run.runId,
            reviewerAgentId: null,
            requiredChanges: ["Continue from independently reconciled interrupted Git progress; re-verify all acceptance criteria."],
            issues: [],
            previousArtifact: {
              provider: progress.provider || run.git?.provider || "",
              branch: progress.branch || run.git?.branch || "",
              commit: String(progress.commit).toLowerCase(),
              baseSha: progress.baseSha || run.git?.baseSha || "",
              targetBranch: progress.targetBranch || run.git?.targetBranch || "",
              changedFiles: clone(progress.changedFiles || []),
              recovered: true
            },
            previousCommit: String(progress.commit).toLowerCase(),
            recovery: { reason: run.failureReason, recoveredAt: now },
            createdAt: now
          };
        }
        task.updatedAt = now;
      }
      await this.persist();
      return { task: task ? this.getTask(task.id) : null, run: this.getRun(runId) };
    };
  }

  if (root.PlanningEngine?.prototype) {
    const proto = root.PlanningEngine.prototype;
    const originalDispatchStage = proto.dispatchStage;
    proto.dispatchStage = async function recoveryGatedDispatchStage(projectId, stage, options = {}) {
      if (!canDispatch()) return { ok: true, pending: true, reason: "lifecycle_dispatch_blocked", project: this.getPublicState() };
      return originalDispatchStage.call(this, projectId, stage, options);
    };

    const originalStartProject = proto.startProject;
    proto.startProject = async function recoveryGatedStartProject(input) {
      if (!canDispatch()) return { ok: false, reason: "lifecycle_dispatch_blocked" };
      return originalStartProject.call(this, input);
    };

    proto.hasActiveGeneration = function hasActiveGeneration() {
      const project = this.projectStore.getActiveProject();
      if (!project || project.status !== "PLANNING" || !project.currentRunId) return false;
      const terminal = project.stageHistory.some((entry) => entry.stage === project.stage && entry.runId === project.currentRunId && ["completed", "interrupted"].includes(entry.status));
      return !terminal;
    };

    proto.interruptForRecovery = async function interruptForRecovery(reason = "stop_now") {
      const project = this.projectStore.getActiveProject();
      if (!project || project.status !== "PLANNING" || !project.currentRunId) return { ok: true, ignored: true };
      const lead = this.getLead();
      if (lead) await this.registry.clearProtocolContext(lead.agentId);
      await this.projectStore.interruptStage?.(project.projectId, reason);
      return { ok: true, interrupted: true, stage: project.stage, runId: project.currentRunId };
    };

    proto.resumeAfterRecovery = async function resumeAfterRecovery() {
      let project = this.projectStore.getActiveProject();
      if (!project || !["PLANNING", "NEEDS_USER"].includes(String(project.status || ""))) return { ok: true, ignored: true };

      const beforeStage = project.stage;
      const beforeRunId = project.currentRunId;
      const recovered = await this.recoverPersistedCompletion?.({ reason: "recovery_resume" });
      project = this.projectStore.getActiveProject();
      if (!project || project.status === "READY"
        || project.stage !== beforeStage
        || project.currentRunId !== beforeRunId) {
        return recovered || { ok: true, recovered: true };
      }

      const lead = this.getLead();
      if (!liveAgent(this.registry, lead)) return { ok: false, reason: "lead_reconnect_required" };
      if (project.currentRunId) {
        const completed = typeof this.currentRunCompleted === "function"
          ? this.currentRunCompleted(project)
          : project.stageHistory.some((entry) => entry.stage === project.stage && entry.runId === project.currentRunId && entry.status === "completed");
        if (completed) {
          if (typeof this.advanceCompletedStage === "function") {
            return this.advanceCompletedStage(project, { lead, reason: "recovery_resume_completed_stage" });
          }
          const next = NEXT_PLANNING_STAGE[project.stage];
          if (!next) return { ok: true, waiting: true };
          return this.dispatchStage(project.projectId, next, { lead });
        }
        await this.registry.setProtocolContext(lead.agentId, {
          projectId: project.projectId,
          taskId: `planning:${project.stage.toLowerCase()}`,
          runId: project.currentRunId
        });
        return { ok: true, waitingForExistingRun: true };
      }
      return this.dispatchStage(project.projectId, project.stage || "DISCOVERY", { lead });
    };
  }

  if (root.ReviewEngine?.prototype) {
    const proto = root.ReviewEngine.prototype;
    const originalTick = proto.tick;
    proto.tick = async function recoveryGatedReviewTick(options = {}) {
      if (!canDispatch()) return { ok: true, pending: true, reason: "lifecycle_dispatch_blocked", review: this.getPublicState() };
      return originalTick.call(this, options);
    };

    proto.interruptForRecovery = async function interruptForRecovery(reason = "stop_now") {
      const interrupted = [];
      for (const review of this.store.active()) {
        if (review.reviewerAgentId) await this.registry.clearProtocolContext(review.reviewerAgentId);
        const replacement = await this.replaceReview(review, reason);
        interrupted.push({ reviewId: review.reviewId, replacementReviewId: replacement?.reviewId || null, taskId: review.taskId });
      }
      return { ok: true, interrupted };
    };

    proto.reconcileForResume = async function reconcileForResume() {
      const issues = [];
      const terminal = await this.reconcileTerminalReviews?.();
      if (terminal?.ok === false) issues.push({ code: terminal.reason || "review_terminal_reconciliation_failed", details: terminal });
      for (const review of this.store.active()) {
        const reviewer = this.registry.getAgent(review.reviewerAgentId);
        if (!liveAgent(this.registry, reviewer)) {
          const replacement = await this.replaceReview(review, "reviewer_unavailable_during_recovery");
          if (!replacement) issues.push({ code: "review_requeue_failed", reviewId: review.reviewId, taskId: review.taskId });
          continue;
        }
        if (review.reviewerAgentId === review.authorAgentId) {
          issues.push({ code: "persisted_self_review_detected", reviewId: review.reviewId, taskId: review.taskId });
          continue;
        }
        await this.registry.setProtocolContext(review.reviewerAgentId, {
          projectId: this.store.summary().projectId,
          taskId: review.taskId,
          runId: review.reviewId
        });
      }
      await this.recoverReviewableTasks?.();
      return { ok: issues.length === 0, issues };
    };
  }

  if (root.SchedulerEngine?.prototype) {
    const proto = root.SchedulerEngine.prototype;
    const originalTickCore = proto._tick;
    proto._tick = async function recoveryGatedSchedulerTick(options = {}) {
      if (!canDispatch()) return { ok: true, pending: true, reason: "lifecycle_dispatch_blocked", scheduler: this.getPublicState() };
      return originalTickCore.call(this, options);
    };

    const originalRestore = proto.restoreActiveContexts;
    proto.restoreActiveContexts = async function recoveryAwareRestoreActiveContexts() {
      if (!recovering()) return originalRestore.call(this);
      for (const run of this.store.activeRuns()) {
        const agent = this.registry.getAgent(run.agentId);
        if (!liveAgent(this.registry, agent)) {
          await this.store.logDecision("recovery_active_run_waiting_reconciliation", { runId: run.runId, taskId: run.taskId, agentId: run.agentId });
          continue;
        }
        await this.registry.setProtocolContext(run.agentId, {
          projectId: this.store.summary().projectId,
          taskId: run.taskId,
          runId: run.runId
        });
      }
    };

    proto.interruptActiveRuns = async function interruptActiveRuns(reason = "stop_now") {
      const interrupted = [];
      for (const run of this.store.activeRuns()) {
        await this.registry.clearProtocolContext(run.agentId);
        const result = await this.store.markInterrupted(run.runId, reason, { refundAttempt: true });
        await this.store.logDecision("run_interrupted", { runId: run.runId, taskId: run.taskId, agentId: run.agentId, reason });
        interrupted.push({ runId: run.runId, taskId: run.taskId, agentId: run.agentId, nextStatus: result?.task?.status || null });
      }
      return { ok: true, interrupted };
    };

    proto.reconcileForResume = async function reconcileForResume() {
      const project = this.projectStore.getActiveProject();
      const snapshot = this.store.getGitSnapshot?.();
      const issues = [];
      if (!project || !this.store.summary().projectId) return { ok: true, ignored: true, issues };

      if (snapshot?.baseSha && snapshot?.defaultBranch) {
        if (!this.gitProvider?.checkBaseFresh) return { ok: false, issues: [{ code: "git_provider_unavailable" }] };
        const fresh = await this.gitProvider.checkBaseFresh(project, snapshot);
        await this.store.recordGitFreshness?.(fresh);
        if (!fresh.ok) return { ok: false, issues: [{ code: fresh.reason || "git_base_reconciliation_failed", details: fresh }] };
      }

      for (const run of this.store.activeRuns()) {
        const agent = this.registry.getAgent(run.agentId);
        if (liveAgent(this.registry, agent)) {
          await this.registry.setProtocolContext(run.agentId, { projectId: this.store.summary().projectId, taskId: run.taskId, runId: run.runId });
          continue;
        }

        const task = this.store.getTask(run.taskId);
        if (!run.git?.required || !run.git?.branch || !snapshot) {
          await this.store.markInterrupted(run.runId, "agent_missing_during_recovery", { refundAttempt: true });
          await this.store.logDecision("recovery_run_interrupted", { runId: run.runId, taskId: run.taskId, reason: "no_remote_git_progress_expected" });
          continue;
        }

        const branchHead = await this.gitProvider.getBranchHead(project, run.git.branch);
        if (!branchHead.ok) {
          if (branchHead.reason === "git_repository_or_ref_unavailable") {
            await this.store.markInterrupted(run.runId, "task_branch_missing_after_recovery", { refundAttempt: true });
            await this.store.logDecision("recovery_run_interrupted", { runId: run.runId, taskId: run.taskId, reason: "task_branch_missing" });
            continue;
          }
          issues.push({ code: branchHead.reason || "git_branch_reconciliation_failed", runId: run.runId, taskId: run.taskId, details: branchHead });
          continue;
        }

        const startSha = String(run.git.startSha || run.git.baseSha || snapshot.baseSha).toLowerCase();
        if (branchHead.sha === startSha) {
          await this.store.markInterrupted(run.runId, "no_remote_progress_after_recovery", { refundAttempt: true });
          await this.store.logDecision("recovery_run_interrupted", { runId: run.runId, taskId: run.taskId, reason: "branch_unchanged", branch: run.git.branch });
          continue;
        }

        const compared = await this.gitProvider.compare(project, snapshot.baseSha, branchHead.sha);
        if (!compared.ok) {
          issues.push({ code: compared.reason || "git_compare_reconciliation_failed", runId: run.runId, taskId: run.taskId, details: compared });
          continue;
        }
        const comparison = compared.comparison || {};
        const mergeBase = String(comparison?.merge_base_commit?.sha || "").toLowerCase();
        const files = [...new Set((Array.isArray(comparison.files) ? comparison.files : []).flatMap((file) => [file?.filename, file?.previous_filename]).map(root.GitProvider.normalizePath).filter(Boolean))].sort();
        if (mergeBase !== String(snapshot.baseSha).toLowerCase() || (Number(comparison.behind_by) || 0) !== 0 || files.length >= 300) {
          issues.push({ code: "recovered_branch_not_safe", runId: run.runId, taskId: run.taskId, branch: run.git.branch, mergeBase, behindBy: Number(comparison.behind_by) || 0, changedFileCount: files.length });
          continue;
        }
        const scope = root.GitProvider.validateChangedFiles(files, task?.scope || {});
        if (!scope.ok) {
          issues.push({ code: scope.reason || "recovered_branch_scope_invalid", runId: run.runId, taskId: run.taskId, details: scope });
          continue;
        }

        await this.store.markInterrupted(run.runId, "recovered_remote_progress", {
          refundAttempt: true,
          recoveredProgress: {
            provider: run.git.provider,
            branch: run.git.branch,
            commit: branchHead.sha,
            baseSha: snapshot.baseSha,
            targetBranch: snapshot.defaultBranch,
            changedFiles: scope.files
          }
        });
        await this.store.logDecision("recovered_remote_progress", {
          runId: run.runId,
          taskId: run.taskId,
          branch: run.git.branch,
          commit: branchHead.sha,
          changedFiles: scope.files
        });
      }

      if (issues.length) return { ok: false, issues };
      if (!["READY_FOR_INTEGRATION", "INTEGRATING", "INTEGRATION_VERIFIED", "NEEDS_USER"].includes(this.store.summary().status)) await this.store.setStatus("RUNNING");
      return { ok: true, issues: [] };
    };
  }

  if (root.IntegrationEngine?.prototype) {
    const proto = root.IntegrationEngine.prototype;
    const originalTick = proto.tick;
    proto.tick = async function recoveryGatedIntegrationTick(options = {}) {
      if (!canDispatch()) return { ok: true, pending: true, reason: "lifecycle_dispatch_blocked", integration: this.getPublicState() };
      return originalTick.call(this, options);
    };

    const originalDispatchCurrent = proto.dispatchCurrent;
    proto.dispatchCurrent = async function recoveryGatedIntegrationDispatch(options = {}) {
      if (!canDispatch()) return { ok: true, pending: true, reason: "lifecycle_dispatch_blocked" };
      return originalDispatchCurrent.call(this, options);
    };

    proto.interruptForRecovery = async function interruptForRecovery(reason = "stop_now") {
      const run = this.store.currentRun();
      if (!run || ["VERIFIED", "ABANDONED", "NEEDS_USER"].includes(run.status)) return { ok: true, ignored: true };
      if (run.agentId) await this.registry.clearProtocolContext(run.agentId);
      await this.store.abandon(run.runId, reason);
      await this.schedulerStore.setStatus("READY_FOR_INTEGRATION");
      const projectId = this.store.summary().projectId || this.projectStore.getActiveProject()?.projectId;
      if (projectId) await this.projectStore.setExecutionStatus?.(projectId, "READY_FOR_INTEGRATION", { phase: 9, reason, abandonedIntegrationRunId: run.runId });
      return { ok: true, interrupted: true, runId: run.runId, agentId: run.agentId };
    };

    proto.reconcileForResume = async function reconcileForResume() {
      const run = this.store.currentRun();
      if (!run) return { ok: true, waiting: true };
      if (["VERIFIED", "ABANDONED", "NEEDS_USER"].includes(run.status)) return { ok: true, terminal: true };
      const agent = this.registry.getAgent(run.agentId);
      if (!liveAgent(this.registry, agent)) return this.interruptForRecovery("integrator_missing_during_recovery");
      await this.registry.setProtocolContext(run.agentId, {
        projectId: this.store.summary().projectId,
        taskId: root.INTEGRATION_TASK_ID || "integration",
        runId: run.runId
      });
      return { ok: true, resumedExistingRun: true };
    };
  }

  if (root.ServiceWorkerOrchestrator?.prototype) {
    const proto = root.ServiceWorkerOrchestrator.prototype;
    const originalPublicState = proto.getPublicState;
    proto.getPublicState = function recoveryAwarePublicState() {
      const state = originalPublicState.call(this);
      const recovery = controller()?.getPublicState?.() || null;
      state.recovery = recovery;
      if (state.project && recovery?.projectId === state.project.projectId && !["IDLE", "RUNNING"].includes(recovery.status)) {
        state.project = { ...state.project, workStatus: state.project.status, status: recovery.status, lifecycle: recovery };
      }
      return state;
    };

    const originalSendPrompt = proto.sendPromptToAgent;
    proto.sendPromptToAgent = async function recoveryGatedSendPrompt(agentId, prompt) {
      if (!canDispatch()) return { ok: false, reason: "lifecycle_dispatch_blocked", agentId };
      return originalSendPrompt.call(this, agentId, prompt);
    };

    const originalStartExecution = proto.startExecution;
    proto.startExecution = async function recoveryGatedStartExecution(payload = {}) {
      if (!canDispatch()) return { ok: false, reason: "lifecycle_dispatch_blocked" };
      return originalStartExecution.call(this, payload);
    };
  }

  root.recoveryDispatchAllowed = canDispatch;
  root.recoveryModeActive = recovering;
})();
