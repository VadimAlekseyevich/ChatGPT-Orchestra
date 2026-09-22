(() => {
  "use strict";
  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};
  const NEXT = { DISCOVERY: "PLAN_V1", PLAN_V1: "CRITIQUE", CRITIQUE: "PLAN_V2", PLAN_V2: "DECOMPOSE", DECOMPOSE: "DAG_CRITIC" };
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

  function isObject(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
  function hasItems(value) { return Array.isArray(value) && value.length > 0; }

  class PlanningEngine {
    constructor({ projectStore, registry, eventBus, sendPrompt, idFactory = null, logger = console } = {}) {
      this.projectStore = projectStore;
      this.registry = registry;
      this.eventBus = eventBus;
      this.sendPrompt = sendPrompt;
      this.idFactory = idFactory || (() => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`);
      this.logger = logger;
      this.unsubscribers = [];
      this.initialized = false;
    }

    getLead() { return this.registry.listAgents().find((agent) => agent.role === "lead") || null; }
    isConnected(agent) { return Boolean(agent && this.registry?.isAgentConnected?.(agent)); }
    getPublicState() { return this.projectStore.summary(); }

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
      if (project.lastError?.reason === "lead_prompt_failed") return "same_run";
      if (project.lastError?.details?.retryMode === "fresh_run") return "fresh_run";
      if (RETRYABLE_ARTIFACT_FAILURES.has(String(project.lastError?.reason || ""))) return "fresh_run";
      return null;
    }
    isRetryableLeadDeliveryFailure(project) { return this.planningRetryMode(project) === "same_run"; }
    canRetryCurrentStage() { return Boolean(this.planningRetryMode(this.projectStore.getActiveProject())); }

    async init() {
      if (this.initialized) return this.getPublicState();
      await this.projectStore.load();
      if (!this.unsubscribers.length) {
        this.unsubscribers.push(this.eventBus.subscribe("completion", (record) => this.handleCompletion(record)));
        this.unsubscribers.push(this.eventBus.subscribe("blocker", (record) => this.handleBlocker(record)));
        this.unsubscribers.push(this.eventBus.subscribe("user", (record) => this.handleBlocker(record)));
      }
      const project = this.projectStore.getActiveProject();
      const lead = this.getLead();
      if (project?.status === "PLANNING" && project.currentRunId && lead) {
        await this.registry.setProtocolContext(lead.agentId, {
          projectId: project.projectId,
          taskId: `planning:${project.stage.toLowerCase()}`,
          runId: project.currentRunId
        });
        const recent = this.eventBus.recent(200).events || [];
        const accepted = [...recent].reverse().find((record) => (
          record?.event?.projectId === project.projectId
          && record?.event?.taskId === `planning:${project.stage.toLowerCase()}`
          && record?.event?.runId === project.currentRunId
          && record?.source?.planningArtifact
        ));
        if (accepted) await this.handleCompletion(accepted);
      }
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

    async resumeCurrentStage({ reason = "fresh_lead_replacement" } = {}) {
      let project = this.projectStore.getActiveProject();
      const retryMode = this.planningRetryMode(project);
      if (!project || (!retryMode && project.status !== "PLANNING") || !project.currentRunId) return { ok: false, reason: "planning_role_not_active" };
      const readiness = await this.ensureLeadPromptReady();
      if (!readiness.ok) return { ...readiness, retryable: true, project: this.getPublicState() };
      const lead = readiness.lead;
      const stage = String(project.stage || "").toUpperCase();
      if (!root.PlanningPrompts?.STAGES?.includes?.(stage)) return { ok: false, reason: "planning_stage_not_resumable", stage };

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
          correctionReason: project.lastError?.reason || "planning_artifact_invalid"
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
      await this.registry.setProtocolContext(lead.agentId, { projectId: project.projectId, taskId, runId });
      const prompt = root.PlanningPrompts.buildPlanningPrompt({
        stage,
        project,
        agentId: lead.agentId,
        runId,
        replacement: true
      });
      const sent = await this.sendPrompt(lead.agentId, prompt);
      if (!sent?.ok) {
        await this.registry.clearProtocolContext?.(lead.agentId);
        await this.projectStore.fail(project.projectId, "lead_prompt_failed", sent || null, "PLANNING");
        return { ok: false, reason: "lead_replacement_prompt_failed", retryable: true, details: sent || null, project: this.getPublicState() };
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
        project: this.getPublicState()
      };
    }

    async dispatchStage(projectId, stage, { lead: readyLead = null, readinessChecked = false, correctionReason = null } = {}) {
      const project = this.projectStore.getProject(projectId);
      if (!project) return { ok: false, reason: "unknown_project" };
      let lead = readyLead || this.getLead();
      if (!readinessChecked) {
        const readiness = await this.ensureLeadPromptReady();
        if (!readiness.ok) {
          const failedRunId = `planning-${stage.toLowerCase()}-${this.idFactory()}`;
          await this.projectStore.beginStage(projectId, { stage, runId: failedRunId });
          if (lead?.agentId) await this.registry.clearProtocolContext?.(lead.agentId);
          await this.projectStore.fail(projectId, "lead_prompt_failed", readiness, "PLANNING");
          return { ok: false, reason: "lead_prompt_failed", retryable: true, details: readiness };
        }
        lead = readiness.lead;
      }
      if (!this.isConnected(lead)) return { ok: false, reason: "lead_not_connected" };

      const runId = `planning-${stage.toLowerCase()}-${this.idFactory()}`;
      const taskId = `planning:${stage.toLowerCase()}`;
      await this.projectStore.beginStage(projectId, { stage, runId });
      await this.registry.setProtocolContext(lead.agentId, { projectId, taskId, runId });
      const current = this.projectStore.getProject(projectId);
      let prompt = root.PlanningPrompts.buildPlanningPrompt({ stage, project: current, agentId: lead.agentId, runId });
      if (correctionReason) {
        prompt = `${prompt}\n\nRETRY CORRECTION:\n- The previous response for this same planning stage was received but rejected by Orchestra validation: ${String(correctionReason)}.\n- Produce a new artifact that exactly satisfies the requested stage schema.\n- Use only the new protocol identity/runId in this prompt; do not reuse any previous eventId or runId.`;
      }
      const result = await this.sendPrompt(lead.agentId, prompt);
      if (!result?.ok) {
        await this.registry.clearProtocolContext?.(lead.agentId);
        await this.projectStore.fail(projectId, "lead_prompt_failed", result || null, "PLANNING");
        return { ok: false, reason: "lead_prompt_failed", retryable: true, details: result || null };
      }
      return { ok: true, project: this.getPublicState() };
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

    async handleCompletion(record) {
      const event = record?.event;
      const project = this.projectStore.getActiveProject();
      const lead = this.getLead();
      if (!event || !project || project.status !== "PLANNING" || !lead) return;
      if (event.agentId !== lead.agentId || event.projectId !== project.projectId) return;

      const stage = String(event.payload?.stage || "").toUpperCase();
      if (stage !== project.stage) {
        await this.projectStore.fail(project.projectId, "planning_stage_mismatch", { expected: project.stage, received: stage });
        return;
      }
      const artifact = record?.source?.planningArtifact;
      const problem = this.artifactCheck(stage, artifact);
      if (problem) {
        this.logger?.warn?.("planning_stage_artifact_rejected", {
          projectId: project.projectId,
          stage,
          runId: event.runId || project.currentRunId || null,
          reason: problem,
          retryable: RETRYABLE_ARTIFACT_FAILURES.has(problem)
        });
        await this.projectStore.fail(project.projectId, problem, {
          stage,
          acceptedRunId: event.runId || project.currentRunId || null,
          retryable: RETRYABLE_ARTIFACT_FAILURES.has(problem),
          retryMode: RETRYABLE_ARTIFACT_FAILURES.has(problem) ? "fresh_run" : null
        }, RETRYABLE_ARTIFACT_FAILURES.has(problem) ? "PLANNING" : "NEEDS_USER");
        return;
      }

      this.logger?.info?.("planning_stage_completed", {
        projectId: project.projectId,
        stage,
        runId: event.runId || project.currentRunId || null
      });
      await this.projectStore.completeStage(project.projectId, { stage, artifact });
      if (stage === "DAG_CRITIC") {
        const validation = root.validateTaskGraph(artifact);
        if (!validation.ok) {
          await this.projectStore.fail(project.projectId, "dag_validation_failed", validation);
          return;
        }
        await this.projectStore.setReady(project.projectId, artifact, validation);
        await this.registry.setProtocolContext(lead.agentId, { projectId: project.projectId, taskId: "planning:complete", runId: "planning-complete" });
        return;
      }
      const next = NEXT[stage];
      if (!next) {
        await this.projectStore.fail(project.projectId, "unknown_next_stage", { stage }, "FAILED");
        return;
      }
      this.logger?.info?.("planning_stage_advancing", { projectId: project.projectId, fromStage: stage, toStage: next });
      const dispatched = await this.dispatchStage(project.projectId, next);
      if (!dispatched?.ok) {
        this.logger?.warn?.("planning_stage_advance_failed", {
          projectId: project.projectId,
          fromStage: stage,
          toStage: next,
          reason: dispatched?.reason || "unknown"
        });
      }
    }

    async handleBlocker(record) {
      const event = record?.event;
      const project = this.projectStore.getActiveProject();
      const lead = this.getLead();
      if (!event || !project || project.status !== "PLANNING" || !lead) return;
      if (event.agentId !== lead.agentId || event.projectId !== project.projectId) return;
      await this.projectStore.fail(project.projectId, `lead_${String(event.event || "blocked").toLowerCase()}`, event.payload || null);
    }
  }

  root.PlanningEngine = PlanningEngine;
  if (typeof module !== "undefined" && module.exports) module.exports = { PlanningEngine, NEXT, RETRYABLE_ARTIFACT_FAILURES };
})();