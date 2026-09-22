(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};
  const ACTIVE_INTEGRATION_GENERATION = new Set(["ASSIGNED", "RUNNING", "REPAIRING"]);
  const RECOVERABLE_STATES = new Set(["PAUSED", "STOPPED", "RECOVERY_REQUIRED", "RECOVERING"]);

  function clone(value) {
    if (typeof structuredClone === "function") return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }
  function liveAgent(registry, agent) {
    if (!agent || ["OFFLINE", "ERROR"].includes(agent.status)) return false;
    if (typeof registry?.isAgentConnected === "function") return Boolean(registry.isAgentConnected(agent));
    return Number.isInteger(agent.tabId);
  }

  class RecoveryController {
    constructor({
      store, projectStore, schedulerStore, reviewStore, integrationStore, registry,
      planningEngine, schedulerEngine, reviewEngine, integrationEngine,
      clock = () => Date.now(), logger = console
    } = {}) {
      this.store = store;
      this.projectStore = projectStore;
      this.schedulerStore = schedulerStore;
      this.reviewStore = reviewStore;
      this.integrationStore = integrationStore;
      this.registry = registry;
      this.planningEngine = planningEngine;
      this.schedulerEngine = schedulerEngine;
      this.reviewEngine = reviewEngine;
      this.integrationEngine = integrationEngine;
      this.clock = clock;
      this.logger = logger;
      this.actions = {};
      this.initialized = false;
      this.bootReady = false;
      this.resumePromise = Promise.resolve();
    }

    setActions(actions = {}) { this.actions = { ...this.actions, ...actions }; }
    getPublicState() {
      const summary = this.store.summary();
      return { ...summary, bootReady: this.bootReady, safePoint: this.safePointSummary() };
    }
    canDispatchNewPrompts() { return this.bootReady && ["IDLE", "RUNNING"].includes(this.store.summary().status); }
    isRecovering() { return this.store.summary().status === "RECOVERING"; }

    async prepareForBoot() {
      this.bootReady = false;
      await this.store.load();
      const state = this.store.summary();
      if (["RUNNING", "PAUSING", "STOPPING", "RECOVERING", "RECOVERY_REQUIRED"].includes(state.status)) {
        await this.store.transition("RECOVERING", {
          reason: "service_worker_restart_reconciliation",
          issues: [],
          snapshot: state.snapshot || null
        });
      }
      return this.getPublicState();
    }

    activePlanningGeneration() {
      return Boolean(this.planningEngine?.hasActiveGeneration?.());
    }

    safePointSummary() {
      const workerRuns = this.schedulerStore?.activeRuns?.() || [];
      const reviews = this.reviewStore?.active?.() || [];
      const integrationRun = this.integrationStore?.currentRun?.() || null;
      const integrationActive = Boolean(integrationRun && ACTIVE_INTEGRATION_GENERATION.has(integrationRun.status));
      return {
        reached: !this.activePlanningGeneration() && workerRuns.length === 0 && reviews.length === 0 && !integrationActive,
        planningActive: this.activePlanningGeneration(),
        activeWorkerRuns: workerRuns.map((run) => ({ runId: run.runId, taskId: run.taskId, agentId: run.agentId })),
        activeReviews: reviews.map((review) => ({ reviewId: review.reviewId, taskId: review.taskId, reviewerAgentId: review.reviewerAgentId })),
        activeIntegration: integrationActive ? { runId: integrationRun.runId, agentId: integrationRun.agentId, status: integrationRun.status } : null
      };
    }

    buildSnapshot(reason = "checkpoint") {
      const project = this.projectStore?.summary?.() || null;
      const scheduler = this.schedulerStore?.summary?.() || null;
      const review = this.reviewStore?.summary?.() || null;
      const integration = this.integrationStore?.summary?.() || null;
      const agents = (this.registry?.listAgents?.() || []).map((agent) => ({
        agentId: agent.agentId,
        role: agent.role,
        status: agent.status,
        tabId: Number.isInteger(agent.tabId) ? agent.tabId : null,
        protocolContext: agent.protocolContext ? clone(agent.protocolContext) : null,
        lastSeenAt: agent.lastSeenAt || 0
      }));
      return {
        schemaVersion: 1,
        reason,
        capturedAt: this.clock(),
        project,
        scheduler,
        review,
        integration,
        agents,
        safePoint: this.safePointSummary()
      };
    }

    async attachProject(projectId, reason = "project_active") {
      if (!projectId) return { ok: false, reason: "project_id_missing" };
      return this.store.attachProject(projectId, { status: "RUNNING", reason });
    }

    continuityIssues() {
      const issues = [];
      const project = this.projectStore?.getActiveProject?.();
      if (!project) return issues;

      if (this.activePlanningGeneration()) {
        const lead = this.planningEngine?.getLead?.();
        if (!liveAgent(this.registry, lead)) issues.push({ code: "lead_reconnect_required", projectId: project.projectId });
      }
      for (const run of this.schedulerStore?.activeRuns?.() || []) {
        if (!liveAgent(this.registry, this.registry.getAgent(run.agentId))) issues.push({ code: "worker_run_requires_reconciliation", runId: run.runId, taskId: run.taskId, agentId: run.agentId });
      }
      for (const review of this.reviewStore?.active?.() || []) {
        if (!liveAgent(this.registry, this.registry.getAgent(review.reviewerAgentId))) issues.push({ code: "review_requires_reconciliation", reviewId: review.reviewId, taskId: review.taskId, agentId: review.reviewerAgentId });
      }
      const integrationRun = this.integrationStore?.currentRun?.();
      if (integrationRun && ACTIVE_INTEGRATION_GENERATION.has(integrationRun.status) && !liveAgent(this.registry, this.registry.getAgent(integrationRun.agentId))) {
        issues.push({ code: "integration_requires_reconciliation", runId: integrationRun.runId, agentId: integrationRun.agentId });
      }
      return issues;
    }

    async afterRuntimeInit() {
      const project = this.projectStore?.getActiveProject?.();
      const control = this.store.summary();
      if (!project) {
        if (control.status !== "IDLE") await this.store.clear({ status: "IDLE" });
        this.initialized = true;
        this.bootReady = true;
        return this.getPublicState();
      }

      if (!control.projectId || control.projectId !== project.projectId) {
        const activeWork = ["PLANNING", "RUNNING", "COMPLETED_UNVERIFIED", "READY_FOR_INTEGRATION", "INTEGRATING", "INTEGRATION_REPAIRING"].includes(project.status)
          || (this.schedulerStore?.summary?.().taskCount || 0) > 0;
        await this.store.attachProject(project.projectId, { status: activeWork ? "RECOVERING" : "RUNNING", reason: "phase9_state_bootstrap" });
      }

      const state = this.store.summary();
      let automaticKick = false;
      if (state.status === "RECOVERING") {
        const issues = this.continuityIssues();
        const interruptedControlFlow = ["PAUSING", "STOPPING"].includes(state.previousStatus);
        if (issues.length || interruptedControlFlow) {
          await this.store.transition("RECOVERY_REQUIRED", {
            reason: interruptedControlFlow ? "interrupted_control_transition" : "runtime_continuity_lost",
            issues,
            snapshot: this.buildSnapshot("startup_recovery_required"),
            reconciled: true
          });
        } else {
          await this.reconcileProtocolContexts();
          await this.store.transition("RUNNING", {
            reason: "service_worker_restart_reconciled",
            issues: [],
            snapshot: this.buildSnapshot("startup_reconciled"),
            reconciled: true
          });
          automaticKick = true;
        }
      }
      this.initialized = true;
      this.bootReady = true;
      if (automaticKick) await this.kickEngines("automatic_service_worker_resume");
      return this.getPublicState();
    }

    async pause() {
      const project = this.projectStore?.getActiveProject?.();
      if (!project) return { ok: false, reason: "no_active_project" };
      const status = this.store.summary().status;
      if (status === "PAUSED" || status === "PAUSING") return { ok: true, recovery: this.getPublicState() };
      if (!["RUNNING", "IDLE"].includes(status)) return { ok: false, reason: "lifecycle_not_pauseable", status };
      if (status === "IDLE") await this.attachProject(project.projectId, "pause_attach_project");
      await this.store.transition("PAUSING", {
        reason: "user_pause_requested",
        issues: [],
        snapshot: this.buildSnapshot("pause_requested")
      });
      await this.tick({ reason: "pause_requested" });
      return { ok: true, recovery: this.getPublicState() };
    }

    activeAgentIds() {
      const ids = new Set();
      for (const run of this.schedulerStore?.activeRuns?.() || []) if (run.agentId) ids.add(run.agentId);
      for (const review of this.reviewStore?.active?.() || []) if (review.reviewerAgentId) ids.add(review.reviewerAgentId);
      const integration = this.integrationStore?.currentRun?.();
      if (integration?.agentId && ACTIVE_INTEGRATION_GENERATION.has(integration.status)) ids.add(integration.agentId);
      if (this.activePlanningGeneration()) {
        const lead = this.planningEngine?.getLead?.();
        if (lead?.agentId) ids.add(lead.agentId);
      }
      return [...ids];
    }

    async stopNow() {
      const project = this.projectStore?.getActiveProject?.();
      if (!project) return { ok: false, reason: "no_active_project" };
      const status = this.store.summary().status;
      if (status === "STOPPED" || status === "STOPPING") return { ok: true, recovery: this.getPublicState() };
      if (status === "IDLE") await this.attachProject(project.projectId, "stop_attach_project");

      await this.store.transition("STOPPING", {
        reason: "user_stop_now_requested",
        issues: [],
        snapshot: this.buildSnapshot("stop_now_requested")
      });

      const stopResults = [];
      for (const agentId of this.activeAgentIds()) {
        try {
          const result = await this.actions.stopAgent?.(agentId);
          stopResults.push({ agentId, ok: Boolean(result?.ok), reason: result?.reason || null });
        } catch (error) {
          stopResults.push({ agentId, ok: false, reason: error?.message || String(error) });
        }
      }

      await this.planningEngine?.interruptForRecovery?.("stop_now");
      const workers = await this.schedulerEngine?.interruptActiveRuns?.("stop_now");
      const reviews = await this.reviewEngine?.interruptForRecovery?.("stop_now");
      const integration = await this.integrationEngine?.interruptForRecovery?.("stop_now");
      await this.reconcileProtocolContexts();

      const snapshot = this.buildSnapshot("stopped");
      snapshot.stopResults = stopResults;
      snapshot.interrupted = { workers: workers || null, reviews: reviews || null, integration: integration || null };
      await this.store.transition("STOPPED", {
        reason: "user_stop_now_completed",
        issues: stopResults.filter((item) => !item.ok).map((item) => ({ code: "stop_generation_failed", ...item })),
        snapshot
      });
      return { ok: true, recovery: this.getPublicState() };
    }

    async tick({ reason = "recovery_tick" } = {}) {
      const status = this.store.summary().status;

      if (status === "RUNNING") {
        const planningWatchdog = await this.planningEngine?.checkWatchdog?.();
        if (planningWatchdog?.ok === false && planningWatchdog.reason === "planning_timeout") {
          await this.store.transition("RECOVERY_REQUIRED", {
            reason: "planning_timeout",
            issues: [{ code: "planning_timeout", details: planningWatchdog }],
            snapshot: this.buildSnapshot("planning_timeout"),
            reconciled: false
          });
          return { ok: false, reason: "planning_timeout", recovery: this.getPublicState() };
        }
        return { ok: true, ignored: true };
      }

      if (status === "RECOVERY_REQUIRED" && this.bootReady) {
        const issues = this.continuityIssues();
        if (!issues.length) {
          return this._resume({ reason: `automatic_continuity_restored:${reason}`, automatic: true });
        }
        return { ok: true, pending: true, issues, recovery: this.getPublicState() };
      }

      if (status !== "PAUSING") return { ok: true, ignored: true };
      const safe = this.safePointSummary();
      if (!safe.reached) return { ok: true, pending: true, safePoint: safe };
      await this.reconcileProtocolContexts();
      await this.store.transition("PAUSED", {
        reason: `safe_point:${reason}`,
        issues: [],
        snapshot: this.buildSnapshot("paused_safe_point")
      });
      return { ok: true, paused: true, recovery: this.getPublicState() };
    }

    async reconcileProtocolContexts() {
      const expected = new Map();
      const project = this.projectStore?.getActiveProject?.();
      if (project && this.activePlanningGeneration()) {
        const lead = this.planningEngine?.getLead?.();
        if (lead?.agentId && project.currentRunId) expected.set(lead.agentId, { projectId: project.projectId, taskId: `planning:${project.stage.toLowerCase()}`, runId: project.currentRunId });
      }
      for (const run of this.schedulerStore?.activeRuns?.() || []) expected.set(run.agentId, { projectId: this.schedulerStore.summary().projectId, taskId: run.taskId, runId: run.runId });
      for (const review of this.reviewStore?.active?.() || []) expected.set(review.reviewerAgentId, { projectId: this.reviewStore.summary().projectId, taskId: review.taskId, runId: review.reviewId });
      const integration = this.integrationStore?.currentRun?.();
      if (integration?.agentId && ACTIVE_INTEGRATION_GENERATION.has(integration.status)) expected.set(integration.agentId, { projectId: this.integrationStore.summary().projectId, taskId: root.INTEGRATION_TASK_ID || "integration", runId: integration.runId });

      for (const agent of this.registry?.listAgents?.() || []) {
        const context = expected.get(agent.agentId) || null;
        const same = JSON.stringify(agent.protocolContext || null) === JSON.stringify(context);
        if (same) continue;
        if (context) await this.registry.setProtocolContext(agent.agentId, context);
        else if (agent.protocolContext) await this.registry.clearProtocolContext(agent.agentId);
      }
      return { ok: true, expected: Object.fromEntries(expected) };
    }

    async resume() {
      this.resumePromise = this.resumePromise.catch(() => {}).then(() => this._resume({ reason: "user_resume_requested", automatic: false }));
      return this.resumePromise;
    }

    async _resume({ reason = "user_resume_requested", automatic = false } = {}) {
      const project = this.projectStore?.getActiveProject?.();
      if (!project) return { ok: false, reason: "no_active_project" };
      const currentStatus = this.store.summary().status;
      if (currentStatus === "RUNNING") return { ok: true, alreadyRunning: true, recovery: this.getPublicState() };
      if (!RECOVERABLE_STATES.has(currentStatus)) return { ok: false, reason: "lifecycle_not_resumable", status: currentStatus };

      await this.store.transition("RECOVERING", {
        reason,
        issues: [],
        snapshot: this.buildSnapshot("resume_requested")
      });

      const issues = [];
      try { await this.actions.reconcileTabs?.(); } catch (error) { issues.push({ code: "tab_reconciliation_failed", message: error?.message || String(error) }); }

      const schedulerSummary = this.schedulerStore?.summary?.();
      if (schedulerSummary?.taskCount > 0 && schedulerSummary.status !== "INTEGRATION_VERIFIED") {
        for (const agent of this.registry?.listAgents?.() || []) {
          if (agent.role === "worker" && !liveAgent(this.registry, agent)) await this.registry.removeAgent?.(agent.agentId);
        }
        const target = Math.max(2, Number(schedulerSummary.settings?.maxWorkers) || 2);
        try {
          const created = await this.actions.createWorkers?.(target);
          if (created && created.ok === false) issues.push({ code: created.reason || "worker_recreation_failed", details: created });
        } catch (error) {
          issues.push({ code: "worker_recreation_failed", message: error?.message || String(error) });
        }
      }

      const planningProject = this.projectStore.getActiveProject();
      if (planningProject?.status === "PLANNING" && !liveAgent(this.registry, this.planningEngine?.getLead?.())) {
        issues.push({ code: "lead_reconnect_required", projectId: planningProject.projectId });
      }

      const scheduler = await this.schedulerEngine?.reconcileForResume?.();
      if (scheduler && scheduler.ok === false) issues.push(...(scheduler.issues || [{ code: "scheduler_reconciliation_failed", details: scheduler }]));
      const reviews = await this.reviewEngine?.reconcileForResume?.();
      if (reviews && reviews.ok === false) issues.push(...(reviews.issues || [{ code: "review_reconciliation_failed", details: reviews }]));
      const integration = await this.integrationEngine?.reconcileForResume?.();
      if (integration && integration.ok === false) issues.push(...(integration.issues || [{ code: integration.reason || "integration_reconciliation_failed", details: integration }]));
      await this.reconcileProtocolContexts();

      if (issues.length) {
        await this.store.transition("RECOVERY_REQUIRED", {
          reason: "resume_reconciliation_incomplete",
          issues,
          snapshot: this.buildSnapshot("resume_failed"),
          reconciled: true
        });
        return { ok: false, reason: "resume_reconciliation_incomplete", issues, recovery: this.getPublicState() };
      }

      await this.store.transition("RUNNING", {
        reason: automatic ? "automatic_resume_reconciled" : "resume_reconciled",
        issues: [],
        snapshot: this.buildSnapshot("resume_reconciled"),
        reconciled: true
      });
      await this.kickEngines(automatic ? "automatic_resume" : "user_resume");
      return { ok: true, recovery: this.getPublicState() };
    }

    async kickEngines(reason) {
      const planning = await this.planningEngine?.resumeAfterRecovery?.();
      if (planning?.ok === false && planning.reason !== "lead_reconnect_required") this.logger.warn?.("[ChatGPT Orchestra] planning_resume_failed", planning);
      await this.reviewEngine?.tick?.({ reason: `recovery:${reason}` });
      await this.schedulerEngine?.tick?.({ reason: `recovery:${reason}` });
      await this.integrationEngine?.tick?.({ reason: `recovery:${reason}` });
    }

    async handleRuntimeMessage(message, sender) {
      const type = message?.type;
      const TYPES = root.MESSAGE_TYPES || {};
      const known = new Set([TYPES.ORCHESTRATOR_GET_RECOVERY, TYPES.ORCHESTRATOR_PAUSE, TYPES.ORCHESTRATOR_STOP_NOW, TYPES.ORCHESTRATOR_RESUME].filter(Boolean));
      if (!known.has(type)) return { handled: false };
      if (sender?.tab) return { handled: true, response: { ok: false, reason: "orchestrator_command_forbidden_from_tab" } };
      if (type === TYPES.ORCHESTRATOR_GET_RECOVERY) return { handled: true, response: { ok: true, recovery: this.getPublicState() } };
      if (type === TYPES.ORCHESTRATOR_PAUSE) return { handled: true, response: await this.pause() };
      if (type === TYPES.ORCHESTRATOR_STOP_NOW) return { handled: true, response: await this.stopNow() };
      if (type === TYPES.ORCHESTRATOR_RESUME) return { handled: true, response: await this.resume() };
      return { handled: false };
    }
  }

  root.RecoveryController = RecoveryController;
  root.RECOVERY_ACTIVE_INTEGRATION_GENERATION = ACTIVE_INTEGRATION_GENERATION;
  root.RecoveryRuntime = root.RecoveryRuntime || { controller: null };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { RecoveryController, ACTIVE_INTEGRATION_GENERATION, RECOVERABLE_STATES };
  }
})();
