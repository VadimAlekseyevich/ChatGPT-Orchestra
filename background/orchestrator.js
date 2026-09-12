(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};
  const CHATGPT_HOME = "https://chatgpt.com/";
  const MAX_WORKERS = 4;
  function asError(error) { return error?.message || String(error || "unknown_error"); }

  class ServiceWorkerOrchestrator {
    constructor({ chromeApi = globalThis.chrome, registry, eventBus = null, planningEngine = null, logger = console, workerUrl = CHATGPT_HOME } = {}) {
      this.chrome = chromeApi;
      this.registry = registry;
      this.eventBus = eventBus;
      this.planningEngine = planningEngine;
      this.logger = logger;
      this.workerUrl = workerUrl;
      this.initialized = false;
    }

    async init() {
      if (this.initialized) return this.getPublicState();
      await this.registry.load();
      if (this.eventBus) await this.eventBus.load();
      if (this.planningEngine) await this.planningEngine.init();
      await this.reconcileRegisteredTabs();
      this.initialized = true;
      return this.getPublicState();
    }

    getPublicState() {
      const snapshot = this.registry.snapshot();
      const agents = Object.values(snapshot.agents);
      return {
        schemaVersion: snapshot.schemaVersion,
        runtimeStatus: snapshot.runtimeStatus,
        updatedAt: snapshot.updatedAt,
        lead: agents.find((agent) => agent.role === "lead") || null,
        workers: agents.filter((agent) => agent.role === "worker"),
        protocol: this.eventBus?.summary?.() || null,
        project: this.planningEngine?.getPublicState?.() || null
      };
    }

    async reconcileRegisteredTabs() {
      for (const agent of this.registry.listAgents()) {
        if (!Number.isInteger(agent.tabId)) continue;
        try {
          const tab = await this.chrome.tabs.get(agent.tabId);
          if (!root.isChatGPTUrl(tab?.url)) {
            await this.registry.updateNavigation(agent.tabId, tab?.url || "");
            continue;
          }
          await this.registry.bindAgent(agent.agentId, { tabId: agent.tabId, chatUrl: tab.url || agent.chatUrl, status: "CONNECTING" });
          await this.refreshAgentFromContent(agent.agentId);
        } catch (error) {
          await this.registry.markOfflineByTabId(agent.tabId, "tab_missing_after_restart");
          this.logger.warn?.("[ChatGPT Orchestra] reconcile_tab_failed", agent.agentId, asError(error));
        }
      }
    }

    async registerActiveLead() {
      const tabs = await this.chrome.tabs.query({ active: true, currentWindow: true });
      const tab = tabs?.[0];
      if (!tab || !Number.isInteger(tab.id) || !root.isChatGPTUrl(tab.url)) return { ok: false, reason: "active_tab_is_not_chatgpt" };
      const alreadyBound = this.registry.getAgentByTabId(tab.id);
      if (alreadyBound?.role === "worker") return { ok: false, reason: "active_tab_is_worker", agentId: alreadyBound.agentId };

      let lead = this.registry.listAgents().find((agent) => agent.role === "lead") || null;
      if (lead && Number.isInteger(lead.tabId) && lead.tabId !== tab.id) return { ok: false, reason: "lead_already_registered", agentId: lead.agentId };
      lead = lead
        ? await this.registry.bindAgent(lead.agentId, { tabId: tab.id, chatUrl: tab.url, status: "CONNECTING" })
        : await this.registry.createAgent({ role: "lead", tabId: tab.id, chatUrl: tab.url, label: "Lead", status: "CONNECTING" });
      await this.registry.setRuntimeStatus("pool_active");
      await this.refreshAgentFromContent(lead.agentId);
      return { ok: true, agent: this.registry.getAgent(lead.agentId), state: this.getPublicState() };
    }

    async createWorkers(targetCount = 3) {
      const target = Math.max(1, Math.min(MAX_WORKERS, Number(targetCount) || 3));
      const workers = this.registry.listAgents().filter((agent) => agent.role === "worker");
      const live = workers.filter((agent) => Number.isInteger(agent.tabId));
      const offline = workers.filter((agent) => !Number.isInteger(agent.tabId));
      const created = [];

      for (let index = live.length; index < target; index += 1) {
        let tab = null;
        let agent = null;
        try {
          tab = await this.chrome.tabs.create({ url: "about:blank", active: false });
          const reusable = offline.shift();
          agent = reusable
            ? await this.registry.bindAgent(reusable.agentId, { tabId: tab.id, chatUrl: this.workerUrl, status: "CONNECTING" })
            : await this.registry.createAgent({ role: "worker", tabId: tab.id, chatUrl: this.workerUrl, label: `Worker ${index + 1}`, status: "CONNECTING" });
          await this.chrome.tabs.update(tab.id, { url: this.workerUrl });
          created.push(agent.agentId);
        } catch (error) {
          if (agent && Number.isInteger(tab?.id)) await this.registry.markOfflineByTabId(tab.id, "worker_tab_create_failed");
          if (Number.isInteger(tab?.id) && this.chrome.tabs.remove) { try { await this.chrome.tabs.remove(tab.id); } catch (_) {} }
          return { ok: false, reason: "worker_tab_create_failed", message: asError(error), created, state: this.getPublicState() };
        }
      }
      await this.registry.setRuntimeStatus("pool_active");
      return { ok: true, created, state: this.getPublicState() };
    }

    async refreshAgentFromContent(agentId) {
      const agent = this.registry.getAgent(agentId);
      if (!agent || !Number.isInteger(agent.tabId)) return { ok: false, reason: "agent_offline" };
      try {
        const response = await this.chrome.tabs.sendMessage(agent.tabId, { type: root.MESSAGE_TYPES.PING, payload: { agentId } });
        await this.registry.updateHeartbeat(agent.tabId, response?.payload || response || {}, agent.chatUrl);
        return { ok: true, agent: this.registry.getAgent(agentId) };
      } catch (error) {
        return { ok: false, reason: "content_not_ready", message: asError(error) };
      }
    }

    async bindProtocolContext(agentId, context = {}) {
      const agent = this.registry.getAgent(agentId);
      if (!agent) return { ok: false, reason: "unknown_agent" };
      return { ok: true, agent: await this.registry.setProtocolContext(agentId, context) };
    }

    async clearProtocolContext(agentId) {
      const agent = this.registry.getAgent(agentId);
      if (!agent) return { ok: false, reason: "unknown_agent" };
      return { ok: true, agent: await this.registry.clearProtocolContext(agentId) };
    }

    async sendPromptToAgent(agentId, prompt) {
      const agent = this.registry.getAgent(agentId);
      if (!agent || !Number.isInteger(agent.tabId)) return { ok: false, reason: "agent_offline" };
      try {
        const result = await this.chrome.tabs.sendMessage(agent.tabId, { type: root.MESSAGE_TYPES.SEND_PROMPT, payload: { prompt: String(prompt || "") } });
        return { ...result, agentId };
      } catch (error) {
        return { ok: false, reason: "agent_unreachable", message: asError(error), agentId };
      }
    }

    async stopAgent(agentId) {
      const agent = this.registry.getAgent(agentId);
      if (!agent || !Number.isInteger(agent.tabId)) return { ok: false, reason: "agent_offline" };
      try {
        const result = await this.chrome.tabs.sendMessage(agent.tabId, { type: root.MESSAGE_TYPES.STOP_GENERATION, payload: { agentId } });
        return { ...result, agentId };
      } catch (error) {
        return { ok: false, reason: "agent_unreachable", message: asError(error), agentId };
      }
    }

    async handleContentMessage(message, sender) {
      const tabId = sender?.tab?.id;
      if (!Number.isInteger(tabId)) return { ok: false, reason: "missing_sender_tab" };
      const agent = this.registry.getAgentByTabId(tabId);
      if (!agent) return { ok: true, ignored: true, reason: "unregistered_tab" };
      const tabUrl = sender.tab.url || agent.chatUrl;
      if (!root.isChatGPTUrl(tabUrl)) {
        await this.registry.updateNavigation(tabId, tabUrl);
        return { ok: false, reason: "registered_tab_outside_chatgpt" };
      }
      const updated = await this.registry.updateHeartbeat(tabId, message?.payload || {}, tabUrl);
      return { ok: true, agent: updated };
    }

    async handleProtocolEvent(message, sender) {
      if (!this.eventBus) return { ok: false, reason: "event_bus_unavailable" };
      const payload = message?.payload || {};
      return this.eventBus.handleEvent(payload.event, sender, {
        responseFingerprint: payload.responseFingerprint || "",
        pathname: payload.pathname || "",
        messageCount: payload.messageCount || 0,
        planningArtifact: payload.planningArtifact || null
      });
    }

    async handleProtocolError(message, sender) {
      if (!this.eventBus) return { ok: false, reason: "event_bus_unavailable" };
      return this.eventBus.handleProtocolError(message?.payload || {}, sender);
    }

    async handleRuntimeMessage(message, sender) {
      const type = message?.type;
      const payload = message?.payload || {};
      if (type === root.MESSAGE_TYPES.ORCHESTRA_EVENT) return this.handleProtocolEvent(message, sender);
      if (type === root.MESSAGE_TYPES.PROTOCOL_ERROR) return this.handleProtocolError(message, sender);

      const contentTypes = new Set([
        root.MESSAGE_TYPES.CONTENT_READY,
        root.MESSAGE_TYPES.CONTENT_HEARTBEAT,
        root.MESSAGE_TYPES.CHAT_STATE,
        root.MESSAGE_TYPES.ASSISTANT_RESPONSE_COMPLETED
      ]);
      if (contentTypes.has(type)) return this.handleContentMessage(message, sender);
      if (sender?.tab) return { ok: false, reason: "orchestrator_command_forbidden_from_tab" };

      if (type === root.MESSAGE_TYPES.ORCHESTRATOR_GET_STATE) return { ok: true, state: this.getPublicState() };
      if (type === root.MESSAGE_TYPES.ORCHESTRATOR_GET_EVENTS) return { ok: true, ...(this.eventBus?.recent?.(payload.limit) || { events: [], rejections: [] }) };
      if (type === root.MESSAGE_TYPES.ORCHESTRATOR_GET_PROJECT) return { ok: true, project: this.planningEngine?.getPublicState?.() || null };
      if (type === root.MESSAGE_TYPES.ORCHESTRATOR_START_PROJECT) {
        if (!this.planningEngine) return { ok: false, reason: "planning_engine_unavailable" };
        return this.planningEngine.startProject({ goal: payload.goal, repositoryUrl: payload.repositoryUrl });
      }
      if (type === root.MESSAGE_TYPES.ORCHESTRATOR_REGISTER_ACTIVE_LEAD) return this.registerActiveLead();
      if (type === root.MESSAGE_TYPES.ORCHESTRATOR_CREATE_WORKERS) return this.createWorkers(payload.count);
      if (type === root.MESSAGE_TYPES.ORCHESTRATOR_BIND_PROTOCOL_CONTEXT) return this.bindProtocolContext(payload.agentId, payload.context);
      if (type === root.MESSAGE_TYPES.ORCHESTRATOR_CLEAR_PROTOCOL_CONTEXT) return this.clearProtocolContext(payload.agentId);
      if (type === root.MESSAGE_TYPES.ORCHESTRATOR_SEND_AGENT_PROMPT) return this.sendPromptToAgent(payload.agentId, payload.prompt);
      if (type === root.MESSAGE_TYPES.ORCHESTRATOR_STOP_AGENT) return this.stopAgent(payload.agentId);
      return { ok: false, reason: "unknown_runtime_message" };
    }

    async handleTabRemoved(tabId) {
      if (!this.registry.getAgentByTabId(tabId)) return;
      await this.registry.markOfflineByTabId(tabId, "tab_closed");
    }

    async handleTabUpdated(tabId, changeInfo, tab) {
      const agent = this.registry.getAgentByTabId(tabId);
      if (!agent) return;
      if (changeInfo?.url) await this.registry.updateNavigation(tabId, changeInfo.url);
      if (changeInfo?.status === "complete" && root.isChatGPTUrl(tab?.url || changeInfo?.url)) await this.refreshAgentFromContent(agent.agentId);
    }
  }

  root.ServiceWorkerOrchestrator = ServiceWorkerOrchestrator;
  root.PHASE2_MAX_WORKERS = MAX_WORKERS;
  if (typeof module !== "undefined" && module.exports) module.exports = { ServiceWorkerOrchestrator, MAX_WORKERS, CHATGPT_HOME };
})();