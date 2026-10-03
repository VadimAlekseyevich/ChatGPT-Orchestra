(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};
  const CHATGPT_HOME = "https://chatgpt.com/";
  const MAX_WORKERS = 4;
  function asError(error) { return error?.message || String(error || "unknown_error"); }

  class ServiceWorkerOrchestrator {
    constructor({ agentRuntime, eventBus = null, planningEngine = null, schedulerEngine = null, logger = console, workerUrl = CHATGPT_HOME } = {}) {
      this.agentRuntime = agentRuntime;
      this.registry = agentRuntime;
      this.eventBus = eventBus;
      this.planningEngine = planningEngine;
      this.schedulerEngine = schedulerEngine;
      this.logger = logger;
      this.workerUrl = workerUrl;
      this.initialized = false;
    }

    senderContext(sender = {}) {
      if (sender?.kind && Object.prototype.hasOwnProperty.call(sender, "sessionId")) return sender;
      return this.agentRuntime?.normalizeSender?.(sender) || { kind: "unknown", sessionId: null, agentId: null, url: "", legacyTabId: null };
    }

    async init() {
      if (this.initialized) return this.getPublicState();
      await this.agentRuntime?.load?.();
      if (this.eventBus) await this.eventBus.load();
      await this.reconcileRegisteredSessions();
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

    async reconcileRegisteredSessions() {
      for (const agent of this.agentRuntime?.listAgents?.() || []) {
        const sessionId = this.agentRuntime?.sessionIdForAgent?.(agent);
        if (!sessionId) continue;
        try {
          const session = await this.agentRuntime.getSession(sessionId);
          if (!root.isChatGPTUrl(session?.url)) {
            await this.agentRuntime.updateSessionNavigation(sessionId, session?.url || "");
            continue;
          }
          await this.agentRuntime.bindAgentToSession(agent.agentId, session, {
            chatUrl: session.url || agent.chatUrl,
            status: "CONNECTING"
          });
          await this.refreshAgentFromContent(agent.agentId);
        } catch (error) {
          await this.agentRuntime.markSessionOffline(sessionId, "session_missing_after_restart");
          this.logger.warn?.("[ChatGPT Orchestra] reconcile_session_failed", agent.agentId, asError(error));
        }
      }
      return this.getPublicState();
    }

    async reconcileRegisteredTabs() { return this.reconcileRegisteredSessions(); }

    async registerActiveLead() {
      const session = await this.agentRuntime?.getActiveSession?.();
      if (!session?.id || !root.isChatGPTUrl(session.url)) return { ok: false, reason: "active_tab_is_not_chatgpt" };
      const alreadyBound = this.agentRuntime.getAgentBySessionId?.(session.id);
      if (alreadyBound?.role === "worker") return { ok: false, reason: "active_tab_is_worker", agentId: alreadyBound.agentId };

      let lead = this.agentRuntime.listAgents().find((agent) => agent.role === "lead") || null;
      const leadSessionId = lead ? this.agentRuntime.sessionIdForAgent?.(lead) : null;
      if (lead && leadSessionId && leadSessionId !== String(session.id)) return { ok: false, reason: "lead_already_registered", agentId: lead.agentId };
      lead = lead
        ? await this.agentRuntime.bindAgentToSession(lead.agentId, session, { chatUrl: session.url, status: "CONNECTING" })
        : await this.agentRuntime.createAgentForSession({ role: "lead", session, chatUrl: session.url, label: "Lead", status: "CONNECTING" });
      await this.agentRuntime.setRuntimeStatus?.("pool_active");
      await this.refreshAgentFromContent(lead.agentId);
      return { ok: true, agent: this.agentRuntime.getAgent(lead.agentId), state: this.getPublicState() };
    }

    async createWorkers(targetCount = 3) {
      const target = Math.max(1, Math.min(MAX_WORKERS, Number(targetCount) || 3));
      const workers = this.agentRuntime.listAgents().filter((agent) => agent.role === "worker");
      const live = workers.filter((agent) => this.agentRuntime.isAgentConnected(agent));
      const offline = workers.filter((agent) => !this.agentRuntime.isAgentConnected(agent));
      const created = [];

      for (let index = live.length; index < target; index += 1) {
        let session = null;
        let agent = null;
        try {
          session = await this.agentRuntime.createSession({ url: "about:blank", active: false });
          const reusable = offline.shift();
          agent = reusable
            ? await this.agentRuntime.bindAgentToSession(reusable.agentId, session, { chatUrl: this.workerUrl, status: "CONNECTING" })
            : await this.agentRuntime.createAgentForSession({ role: "worker", session, chatUrl: this.workerUrl, label: `Worker ${index + 1}`, status: "CONNECTING" });
          await this.agentRuntime.navigateSession(session.id, this.workerUrl);
          created.push(agent.agentId);
        } catch (error) {
          if (agent && session?.id) await this.agentRuntime.markSessionOffline(session.id, "worker_session_create_failed");
          if (session?.id) { try { await this.agentRuntime.removeSession(session.id); } catch (_) {} }
          return { ok: false, reason: "worker_tab_create_failed", message: asError(error), created, state: this.getPublicState() };
        }
      }
      await this.agentRuntime.setRuntimeStatus?.("pool_active");
      return { ok: true, created, state: this.getPublicState() };
    }

    async startExecution(payload = {}) {
      if (!this.schedulerEngine) return { ok: false, reason: "scheduler_unavailable" };
      const project = this.planningEngine?.getPublicState?.();
      if (!project || project.status !== "READY") return { ok: false, reason: "project_not_ready_for_execution", status: project?.status || null };
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

    async refreshAgentFromContent(agentId) {
      const result = await this.agentRuntime?.pingAgent?.(agentId);
      if (!result?.ok) return result || { ok: false, reason: "agent_runtime_unavailable" };
      await this.schedulerEngine?.handleAgentStateChanged?.(result.agent);
      return { ok: true, agent: this.agentRuntime.getAgent(agentId) };
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

    async handleContentMessage(message, sender) {
      const context = this.senderContext(sender);
      if (!context.sessionId) return { ok: false, reason: "missing_sender_session" };
      const agent = context.agentId ? this.agentRuntime.getAgent(context.agentId) : this.agentRuntime.getAgentBySessionId?.(context.sessionId);
      if (!agent) return { ok: true, ignored: true, reason: "unregistered_tab" };
      const sessionUrl = context.url || agent.chatUrl;
      if (!root.isChatGPTUrl(sessionUrl)) {
        await this.agentRuntime.updateSessionNavigation(context.sessionId, sessionUrl);
        return { ok: false, reason: "registered_tab_outside_chatgpt" };
      }
      const updated = await this.agentRuntime.updateHeartbeat(context.sessionId, message?.payload || {}, sessionUrl);
      await this.schedulerEngine?.handleAgentStateChanged?.(updated);
      return { ok: true, agent: updated };
    }

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

      const contentTypes = new Set([
        root.MESSAGE_TYPES.CONTENT_READY,
        root.MESSAGE_TYPES.CONTENT_HEARTBEAT,
        root.MESSAGE_TYPES.CHAT_STATE,
        root.MESSAGE_TYPES.ASSISTANT_RESPONSE_COMPLETED
      ]);
      if (contentTypes.has(type)) return this.handleContentMessage(message, context);
      if (context.sessionId) return { ok: false, reason: "orchestrator_command_forbidden_from_agent_session" };

      if (type === root.MESSAGE_TYPES.ORCHESTRATOR_GET_STATE) return { ok: true, state: this.getPublicState() };
      if (type === root.MESSAGE_TYPES.ORCHESTRATOR_GET_EVENTS) return { ok: true, ...(this.eventBus?.recent?.(payload.limit) || { events: [], rejections: [] }) };
      if (type === root.MESSAGE_TYPES.ORCHESTRATOR_GET_PROJECT) return { ok: true, project: this.planningEngine?.getPublicState?.() || null };
      if (type === root.MESSAGE_TYPES.ORCHESTRATOR_GET_SCHEDULER) return { ok: true, scheduler: this.schedulerEngine?.getPublicState?.() || null };
      if (type === root.MESSAGE_TYPES.ORCHESTRATOR_GET_SCHEDULER_DECISIONS) return { ok: true, decisions: this.schedulerEngine?.getRecentDecisions?.(payload.limit) || [] };
      if (type === root.MESSAGE_TYPES.ORCHESTRATOR_START_PROJECT) return this.planningEngine?.startProject?.({ goal: payload.goal, repositoryUrl: payload.repositoryUrl }) || { ok: false, reason: "planning_engine_unavailable" };
      if (type === root.MESSAGE_TYPES.ORCHESTRATOR_START_EXECUTION) return this.startExecution(payload);
      if (type === root.MESSAGE_TYPES.ORCHESTRATOR_SCHEDULER_TICK) return this.schedulerEngine?.tick?.({ reason: payload.reason || "runtime_tick" }) || { ok: false, reason: "scheduler_unavailable" };
      if (type === root.MESSAGE_TYPES.ORCHESTRATOR_REGISTER_ACTIVE_LEAD) return this.registerActiveLead();
      if (type === root.MESSAGE_TYPES.ORCHESTRATOR_CREATE_WORKERS) return this.createWorkers(payload.count);
      if (type === root.MESSAGE_TYPES.ORCHESTRATOR_BIND_PROTOCOL_CONTEXT) return this.bindProtocolContext(payload.agentId, payload.context);
      if (type === root.MESSAGE_TYPES.ORCHESTRATOR_CLEAR_PROTOCOL_CONTEXT) return this.clearProtocolContext(payload.agentId);
      if (type === root.MESSAGE_TYPES.ORCHESTRATOR_SEND_AGENT_PROMPT) return this.sendPromptToAgent(payload.agentId, payload.prompt);
      if (type === root.MESSAGE_TYPES.ORCHESTRATOR_STOP_AGENT) return this.stopAgent(payload.agentId);
      return { ok: false, reason: "unknown_runtime_message" };
    }

    async handleSessionRemoved(sessionId) {
      const agent = this.agentRuntime.getAgentBySessionId?.(sessionId);
      if (!agent) return;
      await this.agentRuntime.markSessionOffline(sessionId, "session_closed");
      if (agent.role === "lead") await this.planningEngine?.handleAgentUnavailable?.(agent.agentId, "session_closed");
      await this.schedulerEngine?.handleAgentUnavailable?.(agent.agentId, "session_closed");
    }

    async handleTabRemoved(tabId) { return this.handleSessionRemoved(String(tabId)); }

    async handleSessionUpdated(sessionId, changeInfo, session) {
      const agent = this.agentRuntime.getAgentBySessionId?.(sessionId);
      if (!agent) return;
      if (changeInfo?.url) await this.agentRuntime.updateSessionNavigation(sessionId, changeInfo.url);
      if (changeInfo?.status === "complete" && root.isChatGPTUrl(session?.url || changeInfo?.url)) await this.refreshAgentFromContent(agent.agentId);
    }

    async handleTabUpdated(tabId, changeInfo, tab) {
      return this.handleSessionUpdated(String(tabId), changeInfo, tab ? { id: String(tab.id), url: tab.url || "", active: Boolean(tab.active) } : null);
    }
  }

  root.ServiceWorkerOrchestrator = ServiceWorkerOrchestrator;
  root.PHASE2_MAX_WORKERS = MAX_WORKERS;
  if (typeof module !== "undefined" && module.exports) module.exports = { ServiceWorkerOrchestrator, MAX_WORKERS, CHATGPT_HOME };
})();
