(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};
  const STORAGE_KEY = "orchestra.tabRegistry.v1";
  const SCHEMA_VERSION = 1;

  function clone(value) {
    if (typeof structuredClone === "function") return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }

  function defaultState() {
    return {
      schemaVersion: SCHEMA_VERSION,
      runtimeStatus: "idle",
      agents: {},
      updatedAt: 0
    };
  }

  function isChatGPTUrl(url) {
    try {
      const parsed = new URL(String(url || ""));
      return parsed.protocol === "https:"
        && (parsed.hostname === "chatgpt.com" || parsed.hostname === "chat.openai.com");
    } catch (_) {
      return false;
    }
  }

  function deriveAgentStatus(payload = {}) {
    if (payload.generating || payload.availability === "generating") return "BUSY";
    if (payload.availability === "ready") return "IDLE";
    if (payload.availability === "error" || payload.availability === "unavailable") return "ERROR";
    return "CONNECTING";
  }

  class TabRegistry {
    constructor({
      storageArea = globalThis.chrome?.storage?.local,
      clock = () => Date.now(),
      idFactory = () => `agent-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`
    } = {}) {
      this.storageArea = storageArea;
      this.clock = clock;
      this.idFactory = idFactory;
      this.state = defaultState();
      this.loaded = false;
      this.writeChain = Promise.resolve();
    }

    async load() {
      if (!this.storageArea?.get) {
        this.loaded = true;
        return this.snapshot();
      }

      const stored = await this.storageArea.get(STORAGE_KEY);
      const candidate = stored?.[STORAGE_KEY];
      if (candidate?.schemaVersion === SCHEMA_VERSION && candidate.agents && typeof candidate.agents === "object") {
        this.state = {
          ...defaultState(),
          ...candidate,
          agents: { ...candidate.agents }
        };
      }
      this.loaded = true;
      return this.snapshot();
    }

    snapshot() {
      return clone(this.state);
    }

    listAgents() {
      return Object.values(this.state.agents).map((agent) => clone(agent));
    }

    getAgent(agentId) {
      const agent = this.state.agents[agentId];
      return agent ? clone(agent) : null;
    }

    getAgentByTabId(tabId) {
      const numeric = Number(tabId);
      const agent = Object.values(this.state.agents).find((item) => item.tabId === numeric);
      return agent ? clone(agent) : null;
    }

    async persist() {
      this.state.updatedAt = this.clock();
      if (!this.storageArea?.set) return this.snapshot();

      const payload = clone(this.state);
      this.writeChain = this.writeChain
        .catch(() => {})
        .then(() => this.storageArea.set({ [STORAGE_KEY]: payload }));
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
      this.state.agents[agentId] = {
        agentId,
        role: role === "lead" ? "lead" : "worker",
        label: String(label || ""),
        tabId: Number.isInteger(tabId) ? tabId : null,
        chatUrl: String(chatUrl || ""),
        status,
        lastSeenAt: 0,
        createdAt: now,
        updatedAt: now,
        lastError: null
      };
      await this.persist();
      return this.getAgent(agentId);
    }

    async bindAgent(agentId, { tabId, chatUrl, status = "CONNECTING" } = {}) {
      const agent = this.state.agents[agentId];
      if (!agent) return null;

      agent.tabId = Number.isInteger(tabId) ? tabId : agent.tabId;
      agent.chatUrl = String(chatUrl || agent.chatUrl || "");
      agent.status = status;
      agent.updatedAt = this.clock();
      agent.lastError = null;
      await this.persist();
      return this.getAgent(agentId);
    }

    async updateHeartbeat(tabId, payload = {}, chatUrl = "") {
      const existing = this.getAgentByTabId(tabId);
      if (!existing) return null;

      const agent = this.state.agents[existing.agentId];
      const now = this.clock();
      agent.status = deriveAgentStatus(payload);
      agent.chatUrl = String(chatUrl || payload.chatUrl || agent.chatUrl || "");
      agent.lastSeenAt = now;
      agent.updatedAt = now;
      agent.lastError = agent.status === "ERROR"
        ? String(payload.error || payload.availability || "chat_unavailable")
        : null;
      agent.chatState = {
        generating: Boolean(payload.generating),
        availability: payload.availability || "unknown",
        pathname: payload.pathname || "",
        responseFingerprint: payload.responseFingerprint || "",
        messageCount: Number(payload.messageCount) || 0
      };
      await this.persist();
      return this.getAgent(existing.agentId);
    }

    async markOfflineByTabId(tabId, reason = "tab_unavailable") {
      const existing = this.getAgentByTabId(tabId);
      if (!existing) return null;

      const agent = this.state.agents[existing.agentId];
      agent.status = "OFFLINE";
      agent.lastError = reason;
      agent.updatedAt = this.clock();
      agent.tabId = null;
      await this.persist();
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
      } else if (agent.status === "ERROR" && agent.lastError === "navigated_outside_chatgpt") {
        agent.status = "CONNECTING";
        agent.lastError = null;
      }

      await this.persist();
      return this.getAgent(existing.agentId);
    }

    async removeAgent(agentId) {
      if (!this.state.agents[agentId]) return false;
      delete this.state.agents[agentId];
      await this.persist();
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

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { TabRegistry, STORAGE_KEY, isChatGPTUrl, deriveAgentStatus };
  }
})();
