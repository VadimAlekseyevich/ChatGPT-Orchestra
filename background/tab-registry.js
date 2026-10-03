(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};
  const Lifecycle = root.AgentLifecycle || (typeof require === "function" ? require("../platform/agent-lifecycle.js") : null);
  const STORAGE_KEY = "orchestra.tabRegistry.v1";
  const SCHEMA_VERSION = 1;

  function clone(value) {
    if (typeof structuredClone === "function") return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }

  function defaultState() {
    return { schemaVersion: SCHEMA_VERSION, runtimeStatus: "idle", agents: {}, updatedAt: 0 };
  }

  function isChatGPTUrl(url) {
    try {
      const parsed = new URL(String(url || ""));
      return parsed.protocol === "https:" && (parsed.hostname === "chatgpt.com" || parsed.hostname === "chat.openai.com");
    } catch (_) { return false; }
  }

  function deriveAgentStatus(payload = {}) {
    return Lifecycle.normalizeHeartbeat(payload, { hasBinding: true }).legacyStatus;
  }

  function deriveAgentLifecycle(payload = {}, { hasBinding = true } = {}) {
    return Lifecycle.normalizeHeartbeat(payload, { hasBinding });
  }

  function normalizeProtocolContext(context = {}) {
    const normalized = {};
    for (const field of ["projectId", "taskId", "runId"]) {
      const value = String(context?.[field] || "").trim();
      if (value) normalized[field] = value;
    }
    return Object.keys(normalized).length ? normalized : null;
  }

  class TabRegistry {
    constructor({ stateStore = null, storageArea = null, clock = () => Date.now(), idFactory = () => `agent-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}` } = {}) {
      this.stateStore = stateStore || storageArea || null;
      this.clock = clock;
      this.idFactory = idFactory;
      this.state = defaultState();
      this.loaded = false;
      this.writeChain = Promise.resolve();
      this.agentEventListeners = new Set();
    }

    emitAgentEvent(event) {
      if (!event) return;
      const safe = clone(event);
      for (const listener of [...this.agentEventListeners]) {
        try { listener(safe); } catch (_) {}
      }
    }

    subscribeAgentEvents(listener) {
      if (typeof listener !== "function") throw new TypeError("agent_event_listener_invalid");
      this.agentEventListeners.add(listener);
      return () => this.agentEventListeners.delete(listener);
    }

    transition(agent, state, options = {}) {
      const result = Lifecycle.transitionAgentLifecycle(agent, state, { at: this.clock(), ...options });
      if (result?.event) this.emitAgentEvent({ ...result.event, role: agent.role });
      return result;
    }

    async load() {
      if (!this.stateStore?.get) {
        this.loaded = true;
        return this.snapshot();
      }
      const stored = await this.stateStore.get(STORAGE_KEY);
      const candidate = stored?.[STORAGE_KEY];
      if (candidate?.schemaVersion === SCHEMA_VERSION && candidate.agents && typeof candidate.agents === "object") {
        this.state = { ...defaultState(), ...candidate, agents: { ...candidate.agents } };
        for (const agent of Object.values(this.state.agents)) Lifecycle.initializeAgentLifecycle(agent, { at: this.clock() });
      }
      this.loaded = true;
      return this.snapshot();
    }

    snapshot() { return clone(this.state); }
    listAgents() { return Object.values(this.state.agents).map((agent) => clone(agent)); }
    getAgent(agentId) { const agent = this.state.agents[agentId]; return agent ? clone(agent) : null; }
    getAgentLifecycle(agentId) { return Lifecycle.lifecycleForAgent(this.state.agents[String(agentId || "")]); }
    getAgentByTabId(tabId) {
      const numeric = Number(tabId);
      const agent = Object.values(this.state.agents).find((item) => item.tabId === numeric);
      return agent ? clone(agent) : null;
    }

    async persist() {
      this.state.updatedAt = this.clock();
      if (!this.stateStore?.set) return this.snapshot();
      const payload = clone(this.state);
      this.writeChain = this.writeChain.catch(() => {}).then(() => this.stateStore.set({ [STORAGE_KEY]: payload }));
      await this.writeChain;
      return this.snapshot();
    }

    async setRuntimeStatus(runtimeStatus) {
      this.state.runtimeStatus = String(runtimeStatus || "idle");
      return this.persist();
    }

    async createAgent({ role, tabId = null, chatUrl = "", label = "", status = "CONNECTING" } = {}) {
      const agentId = this.idFactory();
      const now = this.clock();
      const agent = {
        agentId,
        role: role === "lead" ? "lead" : "worker",
        label: String(label || ""),
        tabId: Number.isInteger(tabId) ? tabId : null,
        chatUrl: String(chatUrl || ""),
        status: String(status || "CONNECTING"),
        protocolContext: null,
        lastSeenAt: 0,
        createdAt: now,
        updatedAt: now,
        lastError: null
      };
      Lifecycle.initializeAgentLifecycle(agent, { at: now });
      this.state.agents[agentId] = agent;
      await this.persist();
      this.emitAgentEvent({ type: "agent-added", agentId, state: agent.lifecycleState, reason: agent.lifecycleReason, at: now, role: agent.role });
      return this.getAgent(agentId);
    }

    async bindAgent(agentId, { tabId, chatUrl, status = "CONNECTING" } = {}) {
      const agent = this.state.agents[agentId];
      if (!agent) return null;
      agent.tabId = Number.isInteger(tabId) ? tabId : agent.tabId;
      agent.chatUrl = String(chatUrl || agent.chatUrl || "");
      agent.status = String(status || "CONNECTING");
      agent.updatedAt = this.clock();
      agent.lastError = null;
      const target = Lifecycle.stateForLegacyStatus(agent.status);
      this.transition(agent, target, {
        reason: target === Lifecycle.STATES.READY ? "prompt_ready" : target === Lifecycle.STATES.BUSY ? "prompt_active" : "runtime_starting",
        legacyStatus: agent.status,
        readinessCheckedAt: target === Lifecycle.STATES.READY ? agent.updatedAt : null
      });
      await this.persist();
      this.emitAgentEvent({
        type: "agent-binding-changed",
        agentId: agent.agentId,
        binding: Number.isInteger(agent.tabId) ? { kind: "extension-tab", sessionId: String(agent.tabId) } : null,
        at: agent.updatedAt,
        role: agent.role
      });
      return this.getAgent(agentId);
    }

    async setAgentLifecycle(agentId, state, options = {}) {
      const agent = this.state.agents[String(agentId || "")];
      if (!agent) return null;
      agent.updatedAt = this.clock();
      this.transition(agent, state, options);
      await this.persist();
      return this.getAgent(agent.agentId);
    }

    async setProtocolContext(agentId, context) {
      const agent = this.state.agents[agentId];
      if (!agent) return null;
      agent.protocolContext = normalizeProtocolContext(context);
      agent.updatedAt = this.clock();
      await this.persist();
      return this.getAgent(agentId);
    }

    async clearProtocolContext(agentId) { return this.setProtocolContext(agentId, null); }

    async updateHeartbeat(tabId, payload = {}, chatUrl = "") {
      const existing = this.getAgentByTabId(tabId);
      if (!existing) return null;
      const agent = this.state.agents[existing.agentId];
      const now = this.clock();
      const normalized = deriveAgentLifecycle(payload, { hasBinding: Number.isInteger(agent.tabId) });
      agent.chatUrl = String(chatUrl || payload.chatUrl || agent.chatUrl || "");
      agent.lastSeenAt = now;
      agent.updatedAt = now;
      agent.lastError = normalized.state === Lifecycle.STATES.UNAVAILABLE
        ? String(payload.reason || payload.error || normalized.reason)
        : null;
      agent.chatState = {
        generating: Boolean(payload.generating),
        availability: payload.availability || "unknown",
        composerOccupied: payload.composerOccupied === null || payload.composerOccupied === undefined ? null : Boolean(payload.composerOccupied),
        pathname: payload.pathname || "",
        responseFingerprint: payload.responseFingerprint || "",
        messageCount: Number(payload.messageCount) || 0
      };
      this.transition(agent, normalized.state, {
        reason: normalized.reason,
        legacyStatus: normalized.legacyStatus,
        readinessCheckedAt: normalized.state === Lifecycle.STATES.READY ? now : null
      });
      await this.persist();
      return this.getAgent(existing.agentId);
    }

    async markOfflineByTabId(tabId, reason = "tab_unavailable") {
      const existing = this.getAgentByTabId(tabId);
      if (!existing) return null;
      const agent = this.state.agents[existing.agentId];
      agent.status = "OFFLINE";
      agent.lastError = String(reason || "tab_unavailable");
      agent.updatedAt = this.clock();
      agent.tabId = null;
      this.transition(agent, Lifecycle.STATES.UNAVAILABLE, { reason: "session_missing", legacyStatus: "OFFLINE" });
      await this.persist();
      this.emitAgentEvent({ type: "agent-binding-changed", agentId: agent.agentId, binding: null, at: agent.updatedAt, role: agent.role });
      return this.getAgent(existing.agentId);
    }

    async updateNavigation(tabId, url) {
      const existing = this.getAgentByTabId(tabId);
      if (!existing) return null;
      const agent = this.state.agents[existing.agentId];
      agent.chatUrl = String(url || agent.chatUrl || "");
      agent.updatedAt = this.clock();
      if (!isChatGPTUrl(url)) {
        agent.status = "ERROR";
        agent.lastError = "navigated_outside_chatgpt";
        this.transition(agent, Lifecycle.STATES.UNAVAILABLE, { reason: "navigation_in_progress", legacyStatus: "ERROR" });
      } else if (agent.status === "ERROR" && agent.lastError === "navigated_outside_chatgpt") {
        agent.status = "CONNECTING";
        agent.lastError = null;
        this.transition(agent, Lifecycle.STATES.UNAVAILABLE, { reason: "runtime_starting", legacyStatus: "CONNECTING" });
      }
      await this.persist();
      return this.getAgent(existing.agentId);
    }

    async removeAgent(agentId) {
      const agent = this.state.agents[agentId];
      if (!agent) return false;
      delete this.state.agents[agentId];
      await this.persist();
      this.emitAgentEvent({ type: "agent-removed", agentId, previousState: agent.lifecycleState, at: this.clock(), role: agent.role });
      return true;
    }

    async clear({ runtimeStatus = "idle" } = {}) {
      this.state = defaultState();
      this.state.runtimeStatus = runtimeStatus;
      await this.persist();
      return this.snapshot();
    }
  }

  root.TabRegistry = TabRegistry;
  root.TAB_REGISTRY_STORAGE_KEY = STORAGE_KEY;
  root.isChatGPTUrl = isChatGPTUrl;
  root.deriveAgentStatus = deriveAgentStatus;
  root.deriveAgentLifecycle = deriveAgentLifecycle;
  root.normalizeProtocolContext = normalizeProtocolContext;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { TabRegistry, STORAGE_KEY, isChatGPTUrl, deriveAgentStatus, deriveAgentLifecycle, normalizeProtocolContext };
  }
})();