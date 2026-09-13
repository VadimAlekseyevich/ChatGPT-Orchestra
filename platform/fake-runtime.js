(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};
  const Contracts = root.PlatformContracts || (typeof require === "function" ? require("./contracts.js") : null);

  function clone(value) {
    if (typeof structuredClone === "function") return structuredClone(value);
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
  }

  class MemoryStateStore {
    constructor(initial = {}) { this.data = clone(initial || {}); }
    async get(key) {
      if (typeof key === "string") return { [key]: clone(this.data[key]) };
      if (Array.isArray(key)) return Object.fromEntries(key.map((item) => [item, clone(this.data[item])]));
      if (key && typeof key === "object") {
        const result = {};
        for (const [item, fallback] of Object.entries(key)) result[item] = this.data[item] === undefined ? clone(fallback) : clone(this.data[item]);
        return result;
      }
      return clone(this.data);
    }
    async set(values) { for (const [key, value] of Object.entries(values || {})) this.data[key] = clone(value); }
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete this.data[key]; }
    async clear() { this.data = {}; }
    snapshot() { return clone(this.data); }
  }

  class FakeAgentRuntime {
    constructor({ agents = [], responses = {}, clock = () => Date.now() } = {}) {
      this.clock = clock;
      this.agents = new Map();
      this.responses = { ...responses };
      this.prompts = [];
      this.stops = [];
      this.sessions = new Map();
      this.runtimeStatus = "idle";
      this.nextSession = 1;
      this.nextAgent = 1;
      for (const agent of agents) this.addAgent(agent);
    }

    addAgent(agent = {}) {
      const agentId = String(agent.agentId || `agent-${this.nextAgent++}`);
      const sessionId = agent.sessionId === null || agent.sessionId === undefined ? `session-${this.nextSession++}` : String(agent.sessionId);
      const legacyTabId = Number.isInteger(agent.tabId) ? agent.tabId : 10000 + this.nextSession;
      const item = {
        agentId,
        role: agent.role === "lead" ? "lead" : "worker",
        label: String(agent.label || ""),
        status: agent.status || "IDLE",
        protocolContext: agent.protocolContext ? clone(agent.protocolContext) : null,
        lastSeenAt: Number(agent.lastSeenAt) || this.clock(),
        sessionId,
        tabId: legacyTabId,
        chatUrl: String(agent.chatUrl || "https://chatgpt.com/")
      };
      this.agents.set(agentId, item);
      this.sessions.set(sessionId, { id: sessionId, url: item.chatUrl, active: Boolean(agent.active) });
      return clone(item);
    }

    async load() { return this.snapshot(); }
    snapshot() {
      return {
        schemaVersion: 1,
        runtimeStatus: this.runtimeStatus,
        updatedAt: this.clock(),
        agents: Object.fromEntries([...this.agents].map(([id, agent]) => [id, clone(agent)]))
      };
    }
    listAgents() { return [...this.agents.values()].map(clone); }
    getAgent(agentId) { const agent = this.agents.get(agentId); return agent ? clone(agent) : null; }
    getAgentBySessionId(sessionId) {
      const id = String(sessionId || "");
      const agent = [...this.agents.values()].find((item) => item.sessionId === id);
      return agent ? clone(agent) : null;
    }
    getAgentByTabId(tabId) {
      const agent = [...this.agents.values()].find((item) => item.tabId === Number(tabId));
      return agent ? clone(agent) : null;
    }
    isAgentConnected(agentOrId) {
      const agent = typeof agentOrId === "string" ? this.agents.get(agentOrId) : agentOrId;
      return Boolean(agent && agent.sessionId && this.sessions.has(String(agent.sessionId)) && agent.status !== "OFFLINE");
    }
    runtimeBinding(agentOrId) {
      const agent = typeof agentOrId === "string" ? this.agents.get(agentOrId) : agentOrId;
      return agent?.sessionId ? { kind: "fake-session", sessionId: String(agent.sessionId) } : null;
    }
    sessionIdForAgent(agentOrId) { return this.runtimeBinding(agentOrId)?.sessionId || null; }
    async setRuntimeStatus(status) { this.runtimeStatus = String(status || "idle"); return this.snapshot(); }
    async setProtocolContext(agentId, context) {
      const agent = this.agents.get(agentId);
      if (!agent) return null;
      agent.protocolContext = context ? clone(context) : null;
      return this.getAgent(agentId);
    }
    async clearProtocolContext(agentId) { return this.setProtocolContext(agentId, null); }
    async removeAgent(agentId) {
      const agent = this.agents.get(agentId);
      if (!agent) return false;
      if (agent.sessionId) this.sessions.delete(agent.sessionId);
      this.agents.delete(agentId);
      return true;
    }

    normalizeSender(sender = {}) {
      const requestedAgentId = sender.agentId ? String(sender.agentId) : null;
      const byAgent = requestedAgentId ? this.agents.get(requestedAgentId) : null;
      const bySession = sender.sessionId ? this.getAgentBySessionId(sender.sessionId) : null;
      const agent = byAgent || bySession;
      return Contracts.normalizeRuntimeSender({
        kind: agent ? "agent-session" : "test-ui",
        sessionId: agent?.sessionId || sender.sessionId || null,
        agentId: agent?.agentId || null,
        url: agent?.chatUrl || sender.url || ""
      });
    }

    async getActiveSession() {
      const active = [...this.sessions.values()].find((session) => session.active) || [...this.sessions.values()][0] || null;
      return active ? clone(active) : null;
    }
    async getSession(sessionId) {
      const session = this.sessions.get(String(sessionId || ""));
      if (!session) throw new Error("fake_session_missing");
      return clone(session);
    }
    async createSession({ url = "about:blank", active = false } = {}) {
      const id = `session-${this.nextSession++}`;
      const session = { id, url: String(url || ""), active: Boolean(active) };
      this.sessions.set(id, session);
      return clone(session);
    }
    async navigateSession(sessionId, url) {
      const session = this.sessions.get(String(sessionId || ""));
      if (!session) throw new Error("fake_session_missing");
      session.url = String(url || "");
      const agent = this.getAgentBySessionId(session.id);
      if (agent) this.agents.get(agent.agentId).chatUrl = session.url;
      return clone(session);
    }
    async removeSession(sessionId) {
      const id = String(sessionId || "");
      this.sessions.delete(id);
      const agent = this.getAgentBySessionId(id);
      if (agent) {
        const mutable = this.agents.get(agent.agentId);
        mutable.status = "OFFLINE";
        mutable.sessionId = null;
        mutable.tabId = null;
      }
    }
    async bindAgentToSession(agentId, session, { status = "CONNECTING", chatUrl = "" } = {}) {
      const agent = this.agents.get(agentId);
      if (!agent || !session?.id) return null;
      if (!this.sessions.has(String(session.id))) this.sessions.set(String(session.id), clone(session));
      agent.sessionId = String(session.id);
      agent.tabId = Number.isInteger(Number(session.legacyTabId)) ? Number(session.legacyTabId) : agent.tabId || 10000 + this.nextSession;
      agent.chatUrl = String(chatUrl || session.url || agent.chatUrl || "");
      agent.status = status;
      return this.getAgent(agentId);
    }
    async createAgentForSession({ role, session, chatUrl = "", label = "", status = "CONNECTING" } = {}) {
      return this.addAgent({ role, sessionId: session?.id, chatUrl: chatUrl || session?.url, label, status });
    }
    async markSessionOffline(sessionId, reason = "session_unavailable") {
      const agent = this.getAgentBySessionId(sessionId);
      if (!agent) return null;
      const mutable = this.agents.get(agent.agentId);
      mutable.status = "OFFLINE";
      mutable.lastError = reason;
      mutable.sessionId = null;
      mutable.tabId = null;
      return this.getAgent(agent.agentId);
    }
    async updateSessionNavigation(sessionId, url) {
      const session = this.sessions.get(String(sessionId || ""));
      if (session) session.url = String(url || "");
      const agent = this.getAgentBySessionId(sessionId);
      if (!agent) return null;
      const mutable = this.agents.get(agent.agentId);
      mutable.chatUrl = String(url || mutable.chatUrl || "");
      return this.getAgent(agent.agentId);
    }
    async updateHeartbeat(sessionId, payload = {}, url = "") {
      const agent = this.getAgentBySessionId(sessionId);
      if (!agent) return null;
      const mutable = this.agents.get(agent.agentId);
      mutable.status = payload.generating || payload.availability === "generating" ? "BUSY" : payload.availability === "ready" ? "IDLE" : mutable.status;
      mutable.lastSeenAt = this.clock();
      if (url) mutable.chatUrl = String(url);
      return this.getAgent(agent.agentId);
    }
    async pingAgent(agentId) {
      if (!this.isAgentConnected(agentId)) return { ok: false, reason: "agent_offline" };
      const mutable = this.agents.get(agentId);
      mutable.status = mutable.status === "CONNECTING" ? "IDLE" : mutable.status;
      mutable.lastSeenAt = this.clock();
      return { ok: true, agent: this.getAgent(agentId) };
    }
    async sendPrompt(agentId, prompt) {
      if (!this.isAgentConnected(agentId)) return { ok: false, reason: "agent_offline", agentId };
      this.prompts.push({ agentId, prompt: String(prompt || "") });
      const response = this.responses.sendPrompt;
      return typeof response === "function" ? response(agentId, prompt) : { ok: true, agentId };
    }
    async stopAgent(agentId) {
      if (!this.isAgentConnected(agentId)) return { ok: false, reason: "agent_offline", agentId };
      this.stops.push({ agentId });
      const response = this.responses.stopAgent;
      return typeof response === "function" ? response(agentId) : { ok: true, agentId };
    }
  }

  class DeterministicTimerRuntime {
    constructor() { this.entries = new Map(); }
    scheduleRecurring(name, options = {}, listener) {
      const key = String(name || "");
      this.entries.set(key, { options: clone(options), listener });
      return () => this.cancel(key);
    }
    async cancel(name) { this.entries.delete(String(name || "")); }
    async fire(name, payload = null) {
      const entry = this.entries.get(String(name || ""));
      if (!entry) return false;
      await entry.listener(payload || { name: String(name || "") });
      return true;
    }
    list() { return [...this.entries.keys()]; }
  }

  root.MemoryStateStore = MemoryStateStore;
  root.FakeAgentRuntime = FakeAgentRuntime;
  root.DeterministicTimerRuntime = DeterministicTimerRuntime;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { MemoryStateStore, FakeAgentRuntime, DeterministicTimerRuntime };
  }
})();
