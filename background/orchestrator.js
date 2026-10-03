(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};
  const Contracts = root.PlatformContracts || (typeof require === "function" ? require("../platform/contracts.js") : null);
  const MAX_WORKERS = 4;

  class ServiceWorkerOrchestrator {
    constructor({
      agentRuntime,
      agentPool = null,
      eventBus = null,
      planningEngine = null,
      schedulerEngine = null,
      logger = console
    } = {}) {
      this.agentRuntime = agentRuntime;
      this.registry = agentRuntime;
      this.agentPool = agentPool;
      this.eventBus = eventBus;
      this.planningEngine = planningEngine;
      this.schedulerEngine = schedulerEngine;
      this.logger = logger;
      this.initialized = false;
    }

    senderContext(sender = {}) {
      return Contracts.normalizePortableSender(sender || {});
    }

    async init() {
      if (this.initialized) return this.getPublicState();
      await this.agentRuntime?.load?.();
      if (this.eventBus) await this.eventBus.load();
      await this.agentPool?.reconcile?.();
      if (this.planningEngine) await this.planningEngine.init();
      if (this.schedulerEngine) await this.schedulerEngine.init();
      this.initialized = true;
      return this.getPublicState();
    }

    getPublicState() {
      const snapshot = this.agentRuntime?.snapshot?.() || { schemaVersion: 1, runtimeStatus: "idle", agents: {}, updatedAt: 0 };
      const agents = Object.values(snapshot.agents || {});
      return {
        schemaVersion: snapshot.schemaVersion,
        runtimeStatus: snapshot.runtimeStatus,
        updatedAt: snapshot.updatedAt,
        lead: agents.find((agent) => agent.role === "lead") || null,
        workers: agents.filter((agent) => agent.role === "worker"),
        protocol: this.eventBus?.summary?.() || null,
        project: this.planningEngine?.getPublicState?.() || null,
        scheduler: this.schedulerEngine?.getPublicState?.() || null
      };
    }

    async reconcileAgents() {
      const result = await this.agentPool?.reconcile?.();
      return { ...(result || { ok: true }), state: this.getPublicState() };
    }

    async registerActiveLead() {
      if (!this.agentPool?.registerActiveLead) return { ok: false, reason: "agent_pool_unavailable" };
      const result = await this.agentPool.registerActiveLead();
      return { ...(result || { ok: false, reason: "lead_registration_failed" }), state: this.getPublicState() };
    }

    async createWorkers(targetCount = 3) {
      if (!this.agentPool?.ensureWorkers) return { ok: false, reason: "agent_pool_unavailable" };
      const target = Math.max(1, Math.min(MAX_WORKERS, Number(targetCount) || 3));
      const result = await this.agentPool.ensureWorkers(target);
      return { ...(result || { ok: false, reason: "worker_pool_failed" }), state: this.getPublicState() };
    }

    async startExecution(payload = {}) {
      if (!this.schedulerEngine) return { ok: false, reason: "scheduler_unavailable" };
      const project = this.planningEngine?.getPublicState?.();
      if (!project || project.status !== "READY") {
        return { ok: false, reason: "project_not_ready_for_execution", status: project?.status || null };
      }
      const maxWorkers = Math.max(1, Math.min(MAX_WORKERS, Number(payload.maxWorkers) || 3));
      const poolSize = Math.max(2, maxWorkers);
      const workers = await this.createWorkers(poolSize);
      if (!workers.ok) return workers;
      const result = await this.schedulerEngine.start({
        maxWorkers,
        maxRetries: payload.maxRetries ?? 2,
        runTimeoutMs: payload.runTimeoutMs || undefined,
        maxReviewIterations: payload.maxReviewIterations ?? 3
      });
      return { ...result, state: this.getPublicState() };
    }

    async refreshAgent(agentId) {
      const result = await this.agentRuntime?.pingAgent?.(agentId);
      if (!result?.ok) return result || { ok: false, reason: "agent_runtime_unavailable" };
      await this.schedulerEngine?.handleAgentStateChanged?.(result.agent);
      return { ok: true, agent: this.agentRuntime.getAgent(agentId) };
    }

    async handleAgentStateChanged(agentId) {
      const agent = this.agentRuntime?.getAgent?.(agentId);
      if (!agent) return { ok: false, reason: "unknown_agent" };
      await this.schedulerEngine?.handleAgentStateChanged?.(agent);
      return { ok: true, agent };
    }

    async handleAgentUnavailable(agentId, reason = "runtime_unavailable") {
      const agent = this.agentRuntime?.getAgent?.(agentId);
      if (agent?.role === "lead") await this.planningEngine?.handleAgentUnavailable?.(agentId, reason);
      await this.schedulerEngine?.handleAgentUnavailable?.(agentId, reason);
      return { ok: true, agentId: String(agentId || ""), reason };
    }

    async bindProtocolContext(agentId, context = {}) {
      const agent = this.agentRuntime.getAgent(agentId);
      if (!agent) return { ok: false, reason: "unknown_agent" };
      return { ok: true, agent: await this.agentRuntime.setProtocolContext(agentId, context) };
    }

    async clearProtocolContext(agentId) {
      const agent = this.agentRuntime.getAgent(agentId);
      if (!agent) return { ok: false, reason: "unknown_agent" };
      return { ok: true, agent: await this.agentRuntime.clearProtocolContext(agentId) };
    }

    async sendPromptToAgent(agentId, prompt) { return this.agentRuntime.sendPrompt(agentId, prompt); }
    async stopAgent(agentId) { return this.agentRuntime.stopAgent(agentId); }

    async handleProtocolEvent(message, sender) {
      if (!this.eventBus) return { ok: false, reason: "event_bus_unavailable" };
      const payload = message?.payload || {};
      return this.eventBus.handleEvent(payload.event, this.senderContext(sender), {
        responseFingerprint: payload.responseFingerprint || "",
        pathname: payload.pathname || "",
        messageCount: payload.messageCount || 0,
        planningArtifact: payload.planningArtifact || null,
        planningArtifactSignature: payload.planningArtifactSignature || "",
        trace: payload.trace || null
      });
    }

    async handleProtocolError(message, sender) {
      if (!this.eventBus) return { ok: false, reason: "event_bus_unavailable" };
      return this.eventBus.handleProtocolError(message?.payload || {}, this.senderContext(sender));
    }

    async handleRuntimeMessage(message, sender) {
      const context = this.senderContext(sender);
      const type = message?.type;
      const payload = message?.payload || {};

      if (type === root.MESSAGE_TYPES.ORCHESTRA_EVENT) return this.handleProtocolEvent(message, context);
      if (type === root.MESSAGE_TYPES.PROTOCOL_ERROR) return this.handleProtocolError(message, context);

      const adapterOwnedTypes = new Set([
        root.MESSAGE_TYPES.CONTENT_READY,
        root.MESSAGE_TYPES.CONTENT_HEARTBEAT,
        root.MESSAGE_TYPES.CHAT_STATE,
        root.MESSAGE_TYPES.ASSISTANT_RESPONSE_COMPLETED
      ]);
      if (adapterOwnedTypes.has(type)) return { ok: false, reason: "runtime_adapter_required" };

      if (context.agentId) return { ok: false, reason: "orchestrator_command_forbidden_from_agent" };

      if (type === root.MESSAGE_TYPES.ORCHESTRATOR_GET_STATE) return { ok: true, state: this.getPublicState() };
      if (type === root.MESSAGE_TYPES.ORCHESTRATOR_GET_EVENTS) return { ok: true, ...(this.eventBus?.recent?.(payload.limit) || { events: [], rejections: [] }) };
      if (type === root.MESSAGE_TYPES.ORCHESTRATOR_GET_PROJECT) return { ok: true, project: this.planningEngine?.getPublicState?.() || null };
      if (type === root.MESSAGE_TYPES.ORCHESTRATOR_GET_SCHEDULER) return { ok: true, scheduler: this.schedulerEngine?.getPublicState?.() || null };
      if (type === root.MESSAGE_TYPES.ORCHESTRATOR_GET_SCHEDULER_DECISIONS) return { ok: true, decisions: this.schedulerEngine?.getRecentDecisions?.(payload.limit) || [] };
      if (type === root.MESSAGE_TYPES.ORCHESTRATOR_START_PROJECT) {
        return this.planningEngine?.startProject?.({ goal: payload.goal, repositoryUrl: payload.repositoryUrl })
          || { ok: false, reason: "planning_engine_unavailable" };
      }
      if (type === root.MESSAGE_TYPES.ORCHESTRATOR_START_EXECUTION) return this.startExecution(payload);
      if (type === root.MESSAGE_TYPES.ORCHESTRATOR_SCHEDULER_TICK) {
        return this.schedulerEngine?.tick?.({ reason: payload.reason || "runtime_tick" })
          || { ok: false, reason: "scheduler_unavailable" };
      }
      if (type === root.MESSAGE_TYPES.ORCHESTRATOR_REGISTER_ACTIVE_LEAD) return this.registerActiveLead();
      if (type === root.MESSAGE_TYPES.ORCHESTRATOR_CREATE_WORKERS) return this.createWorkers(payload.count);
      if (type === root.MESSAGE_TYPES.ORCHESTRATOR_BIND_PROTOCOL_CONTEXT) return this.bindProtocolContext(payload.agentId, payload.context);
      if (type === root.MESSAGE_TYPES.ORCHESTRATOR_CLEAR_PROTOCOL_CONTEXT) return this.clearProtocolContext(payload.agentId);
      if (type === root.MESSAGE_TYPES.ORCHESTRATOR_SEND_AGENT_PROMPT) return this.sendPromptToAgent(payload.agentId, payload.prompt);
      if (type === root.MESSAGE_TYPES.ORCHESTRATOR_STOP_AGENT) return this.stopAgent(payload.agentId);
      return { ok: false, reason: "unknown_runtime_message" };
    }
  }

  root.ServiceWorkerOrchestrator = ServiceWorkerOrchestrator;
  root.PHASE2_MAX_WORKERS = MAX_WORKERS;
  if (typeof module !== "undefined" && module.exports) module.exports = { ServiceWorkerOrchestrator, MAX_WORKERS };
})();
