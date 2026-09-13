(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};
  const API_VERSION = 1;

  class OrchestratorApi {
    constructor({
      orchestrator,
      planningEngine = null,
      schedulerEngine = null,
      reviewEngine = null,
      integrationEngine = null,
      recoveryController = null,
      eventBus = null
    } = {}) {
      this.orchestrator = orchestrator;
      this.planningEngine = planningEngine;
      this.schedulerEngine = schedulerEngine;
      this.reviewEngine = reviewEngine;
      this.integrationEngine = integrationEngine;
      this.recoveryController = recoveryController;
      this.eventBus = eventBus;
    }

    envelope(data = {}) { return { apiVersion: API_VERSION, ...data }; }

    async query(name, payload = {}) {
      const query = String(name || "");
      if (query === "state") {
        const state = this.orchestrator?.getPublicState?.() || {};
        return this.envelope({
          ok: true,
          state: {
            ...state,
            project: this.planningEngine?.getPublicState?.() || state.project || null,
            scheduler: this.schedulerEngine?.getPublicState?.() || state.scheduler || null,
            review: this.reviewEngine?.getPublicState?.() || null,
            integration: this.integrationEngine?.getPublicState?.() || null,
            recovery: this.recoveryController?.getPublicState?.() || null
          }
        });
      }
      if (query === "events") return this.envelope({ ok: true, ...(this.eventBus?.recent?.(payload.limit) || { events: [], rejections: [] }) });
      if (query === "project") return this.envelope({ ok: true, project: this.planningEngine?.getPublicState?.() || null });
      if (query === "scheduler") return this.envelope({ ok: true, scheduler: this.schedulerEngine?.getPublicState?.() || null });
      if (query === "schedulerDecisions") return this.envelope({ ok: true, decisions: this.schedulerEngine?.getRecentDecisions?.(payload.limit) || [] });
      if (query === "recovery") return this.envelope({ ok: true, recovery: this.recoveryController?.getPublicState?.() || null });
      return this.envelope({ ok: false, reason: "unknown_api_query", query });
    }

    async execute(name, payload = {}) {
      const command = String(name || "");
      let result;
      if (command === "startProject") result = await this.planningEngine?.startProject?.({ goal: payload.goal, repositoryUrl: payload.repositoryUrl });
      else if (command === "startExecution") result = await this.orchestrator?.startExecution?.(payload);
      else if (command === "registerActiveLead") result = await this.orchestrator?.registerActiveLead?.();
      else if (command === "createWorkers") result = await this.orchestrator?.createWorkers?.(payload.count);
      else if (command === "bindProtocolContext") result = await this.orchestrator?.bindProtocolContext?.(payload.agentId, payload.context);
      else if (command === "clearProtocolContext") result = await this.orchestrator?.clearProtocolContext?.(payload.agentId);
      else if (command === "sendAgentPrompt") result = await this.orchestrator?.sendPromptToAgent?.(payload.agentId, payload.prompt);
      else if (command === "stopAgent") result = await this.orchestrator?.stopAgent?.(payload.agentId);
      else if (command === "schedulerTick") result = await this.schedulerEngine?.tick?.({ reason: payload.reason || "api_tick" });
      else if (command === "pause") result = await this.recoveryController?.pause?.();
      else if (command === "stopNow") result = await this.recoveryController?.stopNow?.();
      else if (command === "resume") result = await this.recoveryController?.resume?.();
      else return this.envelope({ ok: false, reason: "unknown_api_command", command });
      if (result === undefined) return this.envelope({ ok: false, reason: "api_dependency_unavailable", command });
      return this.envelope(result && typeof result === "object" ? result : { ok: true, result });
    }

    async handleLegacyMessage(message, senderContext = {}) {
      const TYPES = root.MESSAGE_TYPES || {};
      if (senderContext?.sessionId) return this.envelope({ ok: false, reason: "orchestrator_command_forbidden_from_agent_session" });
      const payload = message?.payload || {};
      const type = message?.type;
      const queryMap = new Map([
        [TYPES.ORCHESTRATOR_GET_STATE, "state"],
        [TYPES.ORCHESTRATOR_GET_EVENTS, "events"],
        [TYPES.ORCHESTRATOR_GET_PROJECT, "project"],
        [TYPES.ORCHESTRATOR_GET_SCHEDULER, "scheduler"],
        [TYPES.ORCHESTRATOR_GET_SCHEDULER_DECISIONS, "schedulerDecisions"],
        [TYPES.ORCHESTRATOR_GET_RECOVERY, "recovery"]
      ]);
      const commandMap = new Map([
        [TYPES.ORCHESTRATOR_START_PROJECT, "startProject"],
        [TYPES.ORCHESTRATOR_START_EXECUTION, "startExecution"],
        [TYPES.ORCHESTRATOR_SCHEDULER_TICK, "schedulerTick"],
        [TYPES.ORCHESTRATOR_PAUSE, "pause"],
        [TYPES.ORCHESTRATOR_STOP_NOW, "stopNow"],
        [TYPES.ORCHESTRATOR_RESUME, "resume"],
        [TYPES.ORCHESTRATOR_REGISTER_ACTIVE_LEAD, "registerActiveLead"],
        [TYPES.ORCHESTRATOR_CREATE_WORKERS, "createWorkers"],
        [TYPES.ORCHESTRATOR_BIND_PROTOCOL_CONTEXT, "bindProtocolContext"],
        [TYPES.ORCHESTRATOR_CLEAR_PROTOCOL_CONTEXT, "clearProtocolContext"],
        [TYPES.ORCHESTRATOR_SEND_AGENT_PROMPT, "sendAgentPrompt"],
        [TYPES.ORCHESTRATOR_STOP_AGENT, "stopAgent"]
      ]);
      if (queryMap.has(type)) return this.query(queryMap.get(type), payload);
      if (commandMap.has(type)) return this.execute(commandMap.get(type), payload);
      return this.envelope({ ok: false, reason: "unknown_runtime_message" });
    }
  }

  root.OrchestratorApi = OrchestratorApi;
  root.ORCHESTRATOR_API_VERSION = API_VERSION;

  if (typeof module !== "undefined" && module.exports) module.exports = { OrchestratorApi, API_VERSION };
})();
