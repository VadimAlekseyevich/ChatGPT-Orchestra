(() => {
  "use strict";
  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};
  const NEXT = { DISCOVERY: "PLAN_V1", PLAN_V1: "CRITIQUE", CRITIQUE: "PLAN_V2", PLAN_V2: "DECOMPOSE", DECOMPOSE: "DAG_CRITIC" };

  function isObject(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
  function hasItems(value) { return Array.isArray(value) && value.length > 0; }

  class PlanningEngine {
    constructor({ projectStore, registry, eventBus, sendPrompt, idFactory = null } = {}) {
      this.projectStore = projectStore;
      this.registry = registry;
      this.eventBus = eventBus;
      this.sendPrompt = sendPrompt;
      this.idFactory = idFactory || (() => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`);
      this.unsubscribers = [];
      this.initialized = false;
    }

    getLead() { return this.registry.listAgents().find((agent) => agent.role === "lead") || null; }
    isConnected(agent) { return Boolean(agent && this.registry?.isAgentConnected?.(agent)); }
    getPublicState() { return this.projectStore.summary(); }

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
      const lead = this.getLead();
      if (!this.isConnected(lead)) return { ok: false, reason: "lead_not_connected" };
      const created = await this.projectStore.createProject({ goal, repositoryUrl });
      if (!created.ok) return created;
      return this.dispatchStage(created.project.projectId, "DISCOVERY");
    }

    async dispatchStage(projectId, stage) {
      const project = this.projectStore.getProject(projectId);
      const lead = this.getLead();
      if (!project) return { ok: false, reason: "unknown_project" };
      if (!this.isConnected(lead)) return { ok: false, reason: "lead_not_connected" };

      const runId = `planning-${stage.toLowerCase()}-${this.idFactory()}`;
      const taskId = `planning:${stage.toLowerCase()}`;
      await this.projectStore.beginStage(projectId, { stage, runId });
      await this.registry.setProtocolContext(lead.agentId, { projectId, taskId, runId });
      const current = this.projectStore.getProject(projectId);
      const prompt = root.PlanningPrompts.buildPlanningPrompt({ stage, project: current, agentId: lead.agentId, runId });
      const result = await this.sendPrompt(lead.agentId, prompt);
      if (!result?.ok) {
        await this.projectStore.fail(projectId, "lead_prompt_failed", result || null);
        return { ok: false, reason: "lead_prompt_failed", details: result || null };
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
        await this.projectStore.fail(project.projectId, problem, { stage });
        return;
      }

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
      await this.dispatchStage(project.projectId, next);
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
  if (typeof module !== "undefined" && module.exports) module.exports = { PlanningEngine, NEXT };
})();
