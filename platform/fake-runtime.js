(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};
  const Contracts = root.PlatformContracts || (typeof require === "function" ? require("./contracts.js") : null);

  function clone(value) {
    if (typeof structuredClone === "function") return structuredClone(value);
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
    async set(values) {
      for (const [key, value] of Object.entries(values || {})) this.data[key] = clone(value);
    }
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete this.data[key];
    }
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
      for (const agent of agents) this.addAgent(agent);
    }

    addAgent(agent = {}) {
      const agentId = String(agent.agentId || `agent-${this.agents.size + 1}`);
      const sessionId = agent.sessionId === null || agent.sessionId === undefined ? `session-${agentId}` : String(agent.sessionId);
      const item = {
        agentId,
        role: agent.role === "lead" ? "lead" : "worker",
        label: String(agent.label || ""),
        status: agent.status || "IDLE",
        protocolContext: agent.protocolContext ? clone(agent.protocolContext) : null,
        lastSeenAt: Number(agent.lastSeenAt) || this.clock(),
        sessionId,
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
    isAgentConnected(agentOrId) {
      const agent = typeof agentOrId === "string" ? this.agents.get(agentOrId) : agentOrId;
      return Boolean(agent && agent.sessionId && !["OFFLINE", "ERROR"].includes(agent.status));
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
      const agentId = sender.agentId ? String(sender.agentId) : null;
      const agent = agentId ? this.agents.get(agentId) : null;
      return Contracts.normalizeRuntimeSender({
        kind: agent ? "agent-session" : "test-ui",
        sessionId: agent?.sessionId || sender.sessionId || null,
        agentId: agent?.agentId || null,
        url: agent?.chatUrl || sender.url || ""
      });
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
