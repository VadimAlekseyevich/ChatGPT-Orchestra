(() => {
  "use strict";
  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};
  const NEXT = { DISCOVERY: "PLAN_V1", PLAN_V1: "CRITIQUE", CRITIQUE: "PLAN_V2", PLAN_V2: "DECOMPOSE", DECOMPOSE: "DAG_CRITIC" };
  const PLANNING_RUN_TIMEOUT_MS = 35 * 60 * 1000;
  const RETRYABLE_ARTIFACT_FAILURES = new Set([
    "stage_artifact_not_object",
    "repository_access_status_missing",
    "repository_inspection_evidence_missing",
    "repository_commands_missing",
    "plan_milestones_missing",
    "completion_definition_missing",
    "critique_findings_missing",
    "revised_plan_milestones_missing",
    "agents_md_proposal_invalid",
    "task_graph_tasks_missing"
  ]);

  const TRACE_FIELDS = ["traceId", "projectId", "taskId", "runId", "agentId", "stage", "sessionId", "dispatchKind", "startedAt"];

  function isObject(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
  function hasItems(value) { return Array.isArray(value) && value.length > 0; }
  function utf8Bytes(value) {
    const text = String(value ?? "");
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(text).length;
    return unescape(encodeURIComponent(text)).length;
  }
  function traceContext(value = null, fallback = {}) {
    const source = isObject(value?.trace) ? value.trace : (isObject(value) ? value : {});
    const base = isObject(fallback?.trace) ? fallback.trace : (isObject(fallback) ? fallback : {});
    const merged = { ...base, ...source };
    const trace = {};
    for (const field of TRACE_FIELDS) {
      if (field === "startedAt") {
        const numeric = Number(merged[field]);
        if (Number.isFinite(numeric) && numeric > 0) trace[field] = numeric;
        continue;
      }
      const text = merged[field] === null || merged[field] === undefined ? "" : String(merged[field]);
      if (text) trace[field] = text;
    }
    return trace;
  }
  function traced(trace, details = {}) {
    return { ...traceContext(trace), ...(isObject(details) ? details : { value: details }) };
  }

  class PlanningEngine {
    constructor({
      projectStore,
      registry,
      eventBus,
      sendPrompt,
      idFactory = null,
      traceIdFactory = null,
      clock = () => Date.now(),
      runTimeoutMs = PLANNING_RUN_TIMEOUT_MS,
      logger = console
    } = {}) {
      this.projectStore = projectStore;
      this.registry = registry;
      this.eventBus = eventBus;
      this.sendPrompt = sendPrompt;
      this.idFactory = idFactory || (() => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`);
      this.traceIdFactory = traceIdFactory || (() => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`);
      this.clock = clock;
      this.runTimeoutMs = Math.max(60_000, Number(runTimeoutMs) || PLANNING_RUN_TIMEOUT_MS);
      this.logger = logger;
      this.unsubscribers = [];
      this.initialized = false;
    }

    getLead() { return this.registry.listAgents().find((agent) => agent.role === "lead") || null; }
    isConnected(agent) { return Boolean(agent && this.registry?.isAgentConnected?.(agent)); }
    getPublicState() { return this.projectStore.summary(); }

    createTrace({ projectId, taskId, runId, agentId, stage, sessionId = null, dispatchKind = "normal" } = {}) {
      return traceContext({
        traceId: `trace-${this.traceIdFactory()}`,
        projectId,
        taskId,
        runId,
        agentId,
        stage,
        sessionId,
        dispatchKind,
        startedAt: this.clock()
      });
    }

    recordTrace(record) {
      return traceContext(record?.source?.trace || record?.agent?.protocolContext, {
        projectId: record?.event?.projectId,
        taskId: record?.event?.taskId,
        runId: record?.event?.runId,
        agentId: record?.event?.agentId,
        stage: record?.event?.payload?.stage,
        sessionId: record?.runtimeSource?.sessionId
      });
    }

    async ensureLeadPromptReady() {
      let lead = this.getLead();
      if (!this.isConnected(lead)) return { ok: false, reason: "lead_not_connected" };

      let ping = null;
      if (typeof this.registry?.pingAgent === "function") {
        try { ping = await this.registry.pingAgent(lead.agentId); }
        catch (error) {
          ping = { ok: false, reason: "lead_readiness_check_failed", message: String(error?.message || error) };
        }
        if (!ping?.ok) return { ok: false, reason: "lead_not_ready", details: ping || null };
        lead = ping.agent || this.getLead() || lead;
      }

      const status = String(lead?.status || "");
      const availability = String(ping?.availability || lead?.chatState?.availability || "");
      const composerOccupied = ping?.composerOccupied === true || lead?.chatState?.composerOccupied === true;
      const generating = ping?.generating === true || status === "BUSY";
      if (status !== "IDLE" || generating || composerOccupied || (availability && availability !== "ready")) {
        return {
          ok: false,
          reason: "lead_not_ready",
          status: status || null,
          availability: availability || null,
          composerOccupied,
          generating,
          details: ping || null
        };
      }
      return { ok: true, lead, details: ping || null };
    }

    planningRetryMode(project) {
      if (!project
        || !["PLANNING", "NEEDS_USER"].includes(String(project.status || ""))
        || !project.currentRunId) return null;
      if (project.lastError?.reason === "lead_prompt_failed") {
        return project.lastError?.details?.promptAccepted === true ? "fresh_run" : "same_run";
      }
      if (project.lastError?.reason === "lead_unavailable") return "same_run";
      if (project.lastError?.reason === "planning_timeout") return "fresh_run";
      if (project.lastError?.details?.retryMode === "fresh_run") return "fresh_run";
      if (RETRYABLE_ARTIFACT_FAILURES.has(String(project.lastError?.reason || ""))) return "fresh_run";
      return null;
    }
    isRetryableLeadDeliveryFailure(project) { return this.planningRetryMode(project) === "same_run"; }
    canRetryCurrentStage() { return Boolean(this.planningRetryMode(this.projectStore.getActiveProject())); }

    currentRunCompleted(project) {
      if (!project?.currentRunId || !project?.stage) return false;
      return (project.stageHistory || []).some((entry) => (
        entry?.stage === project.stage
        && entry?.runId === project.currentRunId
        && entry?.status === "completed"
      ));
    }

    persistedCompletion(project) {
      if (!project?.projectId || !project?.currentRunId || !project?.stage) return null;
      const taskId = `planning:${String(project.stage).toLowerCase()}`;
      const events = this.eventBus?.allEvents?.() || this.eventBus?.recent?.(200)?.events || [];
      return [...events].reverse().find((record) => (
        record?.event?.event === "DONE"
        && record?.event?.projectId === project.projectId
        && record?.event?.taskId === taskId
        && record?.event?.runId === project.currentRunId
        && String(record?.event?.payload?.stage || "").toUpperCase() === String(project.stage).toUpperCase()
        && record?.source?.planningArtifact
      )) || null;
    }

    async init() {
      if (this.initialized) return this.getPublicState();
      await this.projectStore.load();
      if (!this.unsubscribers.length) {
        this.unsubscribers.push(this.eventBus.subscribe("completion", (record) => this.handleCompletion(record)));
        this.unsubscribers.push(this.eventBus.subscribe("blocker", (record) => this.handleBlocker(record)));
        this.unsubscribers.push(this.eventBus.subscribe("user", (record) => this.handleBlocker(record)));
      }
      await this.recoverPersistedCompletion({ reason: "planning_init" });
      this.initialized = true;
      return this.getPublicState();
    }

    async startProject({ goal, repositoryUrl }) {
      const readiness = await this.ensureLeadPromptReady();
      if (!readiness.ok) return readiness;
      const created = await this.projectStore.createProject({ goal, repositoryUrl });
      if (!created.ok) return created;
      return this.dispatchStage(created.project.projectId, "DISCOVERY", { lead: readiness.lead, readinessChecked: true });
    }

    async recoverPersistedCompletion({ reason = "planning_recovery" } = {}) {
      const project = this.projectStore.getActiveProject();
      if (!project || !["PLANNING", "NEEDS_USER"].includes(String(project.status || "")) || !project.currentRunId) {
        return { ok: true, ignored: true };
      }
      if (this.currentRunCompleted(project)) {
        return this.advanceCompletedStage(project, { reason });
      }
      const accepted = this.persistedCompletion(project);
      if (!accepted) return { ok: true, waiting: true, reason: "planning_completion_not_persisted" };
      const result = await this.handleCompletion(accepted, { recovered: true });
      return { ...(result || { ok: true }), recovered: true };
    }

    async resumeCurrentStage({ reason = "fresh_lead_replacement" } = {}) {
      let project = this.projectStore.getActiveProject();
      if (!project || !project.currentRunId) return { ok: false, reason: "planning_role_not_active" };

      const recovered = await this.recoverPersistedCompletion({ reason });
      const afterRecovery = this.projectStore.getActiveProject();
      if (afterRecovery?.projectId === project.projectId
        && (afterRecovery.stage !== project.stage || afterRecovery.currentRunId !== project.currentRunId || afterRecovery.status === "READY")) {
        return { ...recovered, ok: recovered?.ok !== false, resumed: true, recoveredCompletion: true, project: this.getPublicState() };
      }
      project = afterRecovery || project;

      const retryMode = this.planningRetryMode(project);
      if ((!retryMode && project.status !== "PLANNING") || !project.currentRunId) return { ok: false, reason: "planning_role_not_active" };
      const readiness = await this.ensureLeadPromptReady();
      if (!readiness.ok) return { ...readiness, retryable: true, project: this.getPublicState() };
      const lead = readiness.lead;
      const stage = String(project.stage || "").toUpperCase();
      if (!root.PlanningPrompts?.STAGES?.includes?.(stage)) return { ok: false, reason: "planning_stage_not_resumable", stage };

      if (this.currentRunCompleted(project)) {
        return this.advanceCompletedStage(project, { lead, readinessChecked: true, reason });
      }

      if (retryMode === "fresh_run") {
        const previousRunId = project.currentRunId;
        this.logger?.warn?.("planning_stage_retry_fresh_run", {
          projectId: project.projectId,
          stage,
          previousRunId,
          failure: project.lastError?.reason || null,
          reason
        });
        const retried = await this.dispatchStage(project.projectId, stage, {
          lead,
          readinessChecked: true,
          correctionReason: project.lastError?.reason || "planning_artifact_invalid",
          dispatchKind: "fresh_run_corrective_retry"
        });
        return {
          ...retried,
          resumed: Boolean(retried?.ok),
          freshRun: true,
          previousRunId,
          runId: this.projectStore.getActiveProject()?.currentRunId || null,
          reason: retried?.ok ? reason : retried?.reason
        };
      }

      if (retryMode === "same_run") {
        await this.projectStore.clearError?.(project.projectId, "PLANNING");
        project = this.projectStore.getActiveProject();
      }
      const taskId = `planning:${stage.toLowerCase()}`;
      const runId = project.currentRunId;
      const dispatchKind = retryMode === "same_run" ? "same_run_retry" : "recovery";
      const trace = this.createTrace({
        projectId: project.projectId,
        taskId,
        runId,
        agentId: lead.agentId,
        stage,
        sessionId: this.registry?.sessionIdForAgent?.(lead),
        dispatchKind
      });
      await this.registry.setProtocolContext(lead.agentId, {
        projectId: project.projectId,
        taskId,
        runId,
        ...trace
      });
      const prompt = root.PlanningPrompts.buildPlanningPrompt({
        stage,
        project,
        agentId: lead.agentId,
        runId,
        replacement: true
      });
      this.logger?.info?.("planning_stage_dispatch_started", traced(trace, {
        promptBytes: utf8Bytes(prompt),
        planningStatus: project.status || null,
        dispatchKind
      }));
      const sent = await this.sendPrompt(lead.agentId, prompt, { trace });
      if (!sent?.ok) {
        this.logger?.error?.("planning_stage_dispatch_failed", traced(trace, {
          promptBytes: utf8Bytes(prompt),
          planningStatus: project.status || null,
          dispatchKind,
          reason: sent?.reason || "lead_replacement_prompt_failed",
          promptAccepted: sent?.accepted === true || sent?.promptAccepted === true
        }));
        await this.registry.clearProtocolContext?.(lead.agentId);
        await this.projectStore.fail(project.projectId, "lead_prompt_failed", sent || null, "PLANNING");
        return { ok: false, reason: "lead_replacement_prompt_failed", retryable: true, details: sent || null, project: this.getPublicState(), traceId: trace.traceId };
      }
      await this.projectStore.clearError?.(project.projectId);
      return {
        ok: true,
        resumed: true,
        reason,
        logicalRoleId: `lead:${project.projectId}:${stage}`,
        projectId: project.projectId,
        stage,
        runId,
        agentId: lead.agentId,
        traceId: trace.traceId,
        project: this.getPublicState()
      };
    }

    async dispatchStage(projectId, stage, {
      lead: readyLead = null,
      readinessChecked = false,
      correctionReason = null,
      dispatchKind = null
    } = {}) {
      const project = this.projectStore.getProject(projectId);
      if (!project) return { ok: false, reason: "unknown_project" };
      const resolvedDispatchKind = dispatchKind || (correctionReason ? "fresh_run_corrective_retry" : "normal");
      let lead = readyLead || this.getLead();
      if (!readinessChecked) {
        const readiness = await this.ensureLeadPromptReady();
        if (!readiness.ok) {
          const failedRunId = `planning-${stage.toLowerCase()}-${this.idFactory()}`;
          const failedTaskId = `planning:${stage.toLowerCase()}`;
          const trace = this.createTrace({
            projectId,
            taskId: failedTaskId,
            runId: failedRunId,
            agentId: lead?.agentId || null,
            stage,
            sessionId: lead ? this.registry?.sessionIdForAgent?.(lead) : null,
            dispatchKind: resolvedDispatchKind
          });
          await this.projectStore.beginStage(projectId, { stage, runId: failedRunId });
          this.logger?.error?.("planning_stage_dispatch_failed", traced(trace, {
            promptBytes: 0,
            planningStatus: project.status || null,
            dispatchKind: resolvedDispatchKind,
            reason: readiness.reason || "lead_not_ready",
            beforeRuntimeDelivery: true,
            promptAccepted: false
          }));
          if (lead?.agentId) await this.registry.clearProtocolContext?.(lead.agentId);
          await this.projectStore.fail(projectId, "lead_prompt_failed", readiness, "PLANNING");
          return { ok: false, reason: "lead_prompt_failed", retryable: true, details: readiness, traceId: trace.traceId };
        }
        lead = readiness.lead;
      }
      if (!this.isConnected(lead)) return { ok: false, reason: "lead_not_connected" };

      const runId = `planning-${stage.toLowerCase()}-${this.idFactory()}`;
      const taskId = `planning:${stage.toLowerCase()}`;
      await this.projectStore.beginStage(projectId, { stage, runId });
      const trace = this.createTrace({
        projectId,
        taskId,
        runId,
        agentId: lead.agentId,
        stage,
        sessionId: this.registry?.sessionIdForAgent?.(lead),
        dispatchKind: resolvedDispatchKind
      });
      await this.registry.setProtocolContext(lead.agentId, { projectId, taskId, runId, ...trace });
      const current = this.projectStore.getProject(projectId);
      let prompt = root.PlanningPrompts.buildPlanningPrompt({ stage, project: current, agentId: lead.agentId, runId });
      if (correctionReason) {
        prompt = `${prompt}\n\nRETRY CORRECTION:\n- The previous response for this same planning stage was received but rejected by Orchestra validation: ${String(correctionReason)}.\n- Produce a new artifact that exactly satisfies the requested stage schema.\n- Use only the new protocol identity/runId in this prompt; do not reuse any previous eventId or runId.`;
      }
      this.logger?.info?.("planning_stage_dispatch_started", traced(trace, {
        promptBytes: utf8Bytes(prompt),
        planningStatus: current?.status || null,
        dispatchKind: resolvedDispatchKind
      }));
      const result = await this.sendPrompt(lead.agentId, prompt, { trace });
      if (!result?.ok) {
        this.logger?.error?.("planning_stage_dispatch_failed", traced(trace, {
          promptBytes: utf8Bytes(prompt),
          planningStatus: current?.status || null,
          dispatchKind: resolvedDispatchKind,
          reason: result?.reason || "lead_prompt_failed",
          promptAccepted: result?.accepted === true || result?.promptAccepted === true
        }));
        await this.registry.clearProtocolContext?.(lead.agentId);
        await this.projectStore.fail(projectId, "lead_prompt_failed", result || null, "PLANNING");
        return { ok: false, reason: "lead_prompt_failed", retryable: true, details: result || null, traceId: trace.traceId };
      }
      return { ok: true, traceId: trace.traceId, project: this.getPublicState() };
    }

    artifactCheck(stage, artifact) {
      if (!isObject(artifact)) return "stage_artifact_not_object";
      if (stage === "DISCOVERY") {
        const access = artifact.repositoryAccess;
        if (!isObject(access) || !["ok", "partial", "unavailable"].includes(String(access.status || ""))) return "repository_access_status_missing";
        if (access.status === "unavailable") return "repository_access_unavailable";
        if (!hasItems(access.inspectedPaths)) return "repository_inspection_evidence_missing";
        if (!isObject(artifact.commands)) return "repository_commands_missing";
      }
      if (stage === "PLAN_V1") {
        if (!hasItems(artifact.milestones)) return "plan_milestones_missing";
        if (!String(artifact.completionDefinition || "").trim()) return "completion_definition_missing";
      }
      if (stage === "CRITIQUE" && !Array.isArray(artifact.findings)) return "critique_findings_missing";
      if (stage === "PLAN_V2") {
        if (!hasItems(artifact.milestones)) return "revised_plan_milestones_missing";
        if (!String(artifact.completionDefinition || "").trim()) return "completion_definition_missing";
        const action = String(artifact.agentsMdProposal?.action || "");
        if (!["preserve_existing", "propose_new", "no_change"].includes(action)) return "agents_md_proposal_invalid";
      }
      if ((stage === "DECOMPOSE" || stage === "DAG_CRITIC") && !Array.isArray(artifact.tasks)) return "task_graph_tasks_missing";
      return null;
    }

    async advanceCompletedStage(project, {
      lead: readyLead = null,
      readinessChecked = false,
      reason = "stage_completed",
      trace = null
    } = {}) {
      const current = this.projectStore.getProject(project?.projectId) || project;
      if (!current || !this.currentRunCompleted(current)) return { ok: false, reason: "planning_stage_not_completed", planningAdvanced: false };
      const stage = String(current.stage || "").toUpperCase();
      const artifact = current.artifacts?.[stage];
      if (stage === "DAG_CRITIC") {
        const validation = root.validateTaskGraph(artifact);
        if (!validation.ok) {
          await this.projectStore.fail(current.projectId, "dag_validation_failed", validation);
          return { ok: false, reason: "dag_validation_failed", validation, planningAdvanced: false };
        }
        await this.projectStore.setReady(current.projectId, artifact, validation);
        const lead = readyLead || this.getLead();
        if (this.isConnected(lead)) {
          await this.registry.setProtocolContext(lead.agentId, { projectId: current.projectId, taskId: "planning:complete", runId: "planning-complete" });
        }
        this.logger?.info?.("planning_stage_advancing", traced(trace, {
          projectId: current.projectId,
          fromStage: stage,
          toStage: "READY",
          reason
        }));
        return { ok: true, ready: true, reason, planningAdvanced: true, project: this.getPublicState() };
      }

      const next = NEXT[stage];
      if (!next) {
        await this.projectStore.fail(current.projectId, "unknown_next_stage", { stage }, "FAILED");
        return { ok: false, reason: "unknown_next_stage", stage, planningAdvanced: false };
      }

      let lead = readyLead || this.getLead();
      if (!this.isConnected(lead)) {
        return { ok: true, waitingForLead: true, completedStage: stage, nextStage: next, reason, planningAdvanced: false, project: this.getPublicState() };
      }
      if (!readinessChecked) {
        const readiness = await this.ensureLeadPromptReady();
        if (!readiness.ok) {
          return { ok: true, waitingForLead: true, completedStage: stage, nextStage: next, reason: readiness.reason, planningAdvanced: false, project: this.getPublicState() };
        }
        lead = readiness.lead;
        readinessChecked = true;
      }
      this.logger?.info?.("planning_stage_advancing", traced(trace, {
        projectId: current.projectId,
        fromStage: stage,
        toStage: next,
        reason
      }));
      const dispatched = await this.dispatchStage(current.projectId, next, { lead, readinessChecked });
      return { ...dispatched, planningAdvanced: Boolean(dispatched?.ok) };
    }

    async handleCompletion(record, { recovered = false } = {}) {
      const event = record?.event;
      let project = this.projectStore.getActiveProject();
      const trace = this.recordTrace(record);
      if (!event || !project || !["PLANNING", "NEEDS_USER"].includes(String(project.status || "")) || !project.currentRunId) {
        if (event) {
          this.logger?.warn?.("planning_completion_ignored", traced(trace, {
            reason: "planning_not_active",
            receivedProjectId: event.projectId || null,
            receivedTaskId: event.taskId || null,
            receivedRunId: event.runId || null
          }));
        }
        return { ok: true, ignored: true, planningConsumed: false, planningAdvanced: false };
      }
      const expectedTaskId = `planning:${String(project.stage || "").toLowerCase()}`;
      let mismatchReason = null;
      if (event.event !== "DONE") mismatchReason = "event_type_mismatch";
      else if (event.projectId !== project.projectId) mismatchReason = "project_id_mismatch";
      else if (event.runId !== project.currentRunId) mismatchReason = "run_id_mismatch";
      else if (event.taskId !== expectedTaskId) mismatchReason = "task_id_mismatch";
      if (mismatchReason) {
        this.logger?.warn?.("planning_completion_ignored", traced(trace, {
          reason: mismatchReason,
          expectedProjectId: project.projectId,
          receivedProjectId: event.projectId || null,
          expectedTaskId,
          receivedTaskId: event.taskId || null,
          expectedRunId: project.currentRunId,
          receivedRunId: event.runId || null,
          expectedEvent: "DONE",
          receivedEvent: event.event || null
        }));
        return { ok: true, ignored: true, planningConsumed: false, planningAdvanced: false };
      }

      const stage = String(event.payload?.stage || "").toUpperCase();
      if (stage !== project.stage) {
        this.logger?.warn?.("planning_completion_ignored", traced(trace, {
          reason: "planning_stage_mismatch",
          expectedStage: project.stage,
          receivedStage: stage
        }));
        await this.projectStore.fail(project.projectId, "planning_stage_mismatch", { expected: project.stage, received: stage });
        return { ok: false, reason: "planning_stage_mismatch", planningConsumed: false, planningAdvanced: false };
      }

      this.logger?.info?.("planning_completion_consumed", traced(trace, {
        eventId: event.eventId || null,
        projectId: project.projectId,
        taskId: expectedTaskId,
        runId: event.runId,
        stage,
        recovered
      }));

      if (this.currentRunCompleted(project)) {
        const advanced = await this.advanceCompletedStage(project, {
          reason: recovered ? "replayed_completed_stage" : "duplicate_completed_stage",
          trace
        });
        return { ...advanced, planningConsumed: true };
      }

      const artifact = record?.source?.planningArtifact;
      const problem = this.artifactCheck(stage, artifact);
      if (problem) {
        this.logger?.warn?.("planning_stage_artifact_rejected", traced(trace, {
          projectId: project.projectId,
          stage,
          runId: event.runId || project.currentRunId || null,
          reason: problem,
          retryable: RETRYABLE_ARTIFACT_FAILURES.has(problem)
        }));
        await this.projectStore.fail(project.projectId, problem, {
          stage,
          acceptedRunId: event.runId || project.currentRunId || null,
          retryable: RETRYABLE_ARTIFACT_FAILURES.has(problem),
          retryMode: RETRYABLE_ARTIFACT_FAILURES.has(problem) ? "fresh_run" : null
        }, RETRYABLE_ARTIFACT_FAILURES.has(problem) ? "PLANNING" : "NEEDS_USER");
        return {
          ok: false,
          reason: problem,
          retryable: RETRYABLE_ARTIFACT_FAILURES.has(problem),
          planningConsumed: true,
          planningAdvanced: false
        };
      }

      this.logger?.info?.("planning_stage_completed", traced(trace, {
        projectId: project.projectId,
        stage,
        runId: event.runId || project.currentRunId || null,
        recovered
      }));
      await this.projectStore.completeStage(project.projectId, { stage, artifact });
      await this.projectStore.clearError?.(project.projectId, "PLANNING");
      project = this.projectStore.getProject(project.projectId);
      const advanced = await this.advanceCompletedStage(project, {
        reason: recovered ? "persisted_completion_replayed" : "stage_completed",
        trace
      });
      return { ...advanced, planningConsumed: true };
    }

    async handleBlocker(record) {
      const event = record?.event;
      const project = this.projectStore.getActiveProject();
      const lead = this.getLead();
      if (!event || !project || !["PLANNING", "NEEDS_USER"].includes(String(project.status || "")) || !lead) return;
      if (event.agentId !== lead.agentId
        || event.projectId !== project.projectId
        || event.runId !== project.currentRunId
        || event.taskId !== `planning:${String(project.stage || "").toLowerCase()}`) return;
      await this.projectStore.fail(project.projectId, `lead_${String(event.event || "blocked").toLowerCase()}`, event.payload || null);
    }

    async handleAgentUnavailable(agentId, reason = "lead_unavailable") {
      const project = this.projectStore.getActiveProject();
      const lead = this.getLead();
      if (!project || project.status !== "PLANNING" || !project.currentRunId || !lead || lead.agentId !== agentId) {
        return { ok: true, ignored: true };
      }
      await this.registry.clearProtocolContext?.(agentId);
      await this.projectStore.fail(project.projectId, "lead_unavailable", {
        reason: String(reason || "lead_unavailable"),
        retryable: true,
        retryMode: "same_run"
      }, "PLANNING");
      return { ok: true, handled: true, project: this.getPublicState() };
    }

    async checkWatchdog() {
      const project = this.projectStore.getActiveProject();
      if (!project || project.status !== "PLANNING" || !project.currentRunId || this.currentRunCompleted(project)) {
        return { ok: true, ignored: true };
      }
      const started = [...(project.stageHistory || [])].reverse().find((entry) => (
        entry?.stage === project.stage && entry?.runId === project.currentRunId && entry?.status === "started"
      ));
      const startedAt = Number(started?.at) || 0;
      if (!startedAt || this.clock() - startedAt < this.runTimeoutMs) return { ok: true, pending: true };
      const lead = this.getLead();
      if (lead?.agentId) await this.registry.clearProtocolContext?.(lead.agentId);
      await this.projectStore.fail(project.projectId, "planning_timeout", {
        stage: project.stage,
        runId: project.currentRunId,
        timeoutMs: this.runTimeoutMs,
        retryable: true,
        retryMode: "fresh_run"
      }, "PLANNING");
      this.logger?.warn?.("planning_run_timeout", {
        projectId: project.projectId,
        stage: project.stage,
        runId: project.currentRunId,
        timeoutMs: this.runTimeoutMs
      });
      return { ok: false, reason: "planning_timeout", retryable: true, project: this.getPublicState() };
    }
  }

  root.PlanningEngine = PlanningEngine;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { PlanningEngine, NEXT, RETRYABLE_ARTIFACT_FAILURES, PLANNING_RUN_TIMEOUT_MS };
  }
})();
