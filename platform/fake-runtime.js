(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};
  const Contracts = root.PlatformContracts || (typeof require === "function" ? require("./contracts.js") : null);
  const Lifecycle = root.AgentLifecycle || (typeof require === "function" ? require("./agent-lifecycle.js") : null);

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
    constructor({ agents = [], responses = {}, clock = () => Date.now(), readinessTtlMs = 30000 } = {}) {
      this.clock = clock;
      this.readinessTtlMs = Math.max(0, Number(readinessTtlMs) || 30000);
      this.agents = new Map();
      this.responses = { ...responses };
      this.prompts = [];
      this.stops = [];
      this.sessions = new Map();
      this.runtimeStatus = "idle";
      this.nextSession = 1;
      this.nextAgent = 1;
      this.agentEventListeners = new Set();
      for (const agent of agents) this.addAgent(agent);
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

    transitionAgent(agentOrId, state, options = {}) {
      const agent = typeof agentOrId === "string" ? this.agents.get(agentOrId) : agentOrId;
      if (!agent) return null;
      const result = Lifecycle.transitionAgentLifecycle(agent, state, { at: this.clock(), ...options });
      if (result?.event) this.emitAgentEvent({ ...result.event, role: agent.role });
      return result;
    }

    async setAgentLifecycle(agentId, state, options = {}) {
      const result = this.transitionAgent(String(agentId || ""), state, options);
      return result ? this.getAgent(agentId) : null;
    }

    addAgent(agent = {}) {
      const agentId = String(agent.agentId || `agent-${this.nextAgent++}`);
      const sessionId = agent.sessionId === null || agent.sessionId === undefined ? `session-${this.nextSession++}` : String(agent.sessionId);
      const legacyTabId = Number.isInteger(agent.tabId) ? agent.tabId : 10000 + this.nextSession;
      const now = this.clock();
      const item = {
        agentId,
        role: agent.role === "lead" ? "lead" : "worker",
        label: String(agent.label || ""),
        status: agent.status || "IDLE",
        protocolContext: agent.protocolContext ? clone(agent.protocolContext) : null,
        lastSeenAt: Number(agent.lastSeenAt) || now,
        sessionId,
        tabId: legacyTabId,
        chatUrl: String(agent.chatUrl || "https://chatgpt.com/"),
        lastError: agent.lastError ?? null,
        lifecycleState: agent.lifecycleState,
        lifecycleReason: agent.lifecycleReason,
        lifecycleChangedAt: agent.lifecycleChangedAt,
        readinessCheckedAt: agent.readinessCheckedAt,
        lifecycleDetails: agent.lifecycleDetails ? clone(agent.lifecycleDetails) : null,
        createdAt: Number(agent.createdAt) || now,
        updatedAt: Number(agent.updatedAt) || now
      };
      Lifecycle.initializeAgentLifecycle(item, { at: now });
      this.agents.set(agentId, item);
      this.sessions.set(sessionId, { id: sessionId, url: item.chatUrl, active: Boolean(agent.active) });
      this.emitAgentEvent({ type: "agent-added", agentId, state: item.lifecycleState, reason: item.lifecycleReason, at: now, role: item.role });
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
    getAgent(agentId) { const agent = this.agents.get(String(agentId || "")); return agent ? clone(agent) : null; }
    getAgentLifecycle(agentId) { return Lifecycle.lifecycleForAgent(this.agents.get(String(agentId || ""))); }
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
    isAgentReady(agentOrId) {
      const agent = typeof agentOrId === "string" ? this.agents.get(agentOrId) : agentOrId;
      return this.isAgentConnected(agent) && Lifecycle.isReady(agent, { now: this.clock(), readinessTtlMs: this.readinessTtlMs });
    }
    isAgentBusy(agentOrId) {
      const agent = typeof agentOrId === "string" ? this.agents.get(agentOrId) : agentOrId;
      return this.isAgentConnected(agent) && Lifecycle.isBusy(agent);
    }
    isAgentAvailable(agentOrId) {
      const agent = typeof agentOrId === "string" ? this.agents.get(agentOrId) : agentOrId;
      return this.isAgentConnected(agent) && Lifecycle.isAvailable(agent);
    }
    runtimeBinding(agentOrId) {
      const agent = typeof agentOrId === "string" ? this.agents.get(agentOrId) : agentOrId;
      return agent?.sessionId ? { kind: "fake-session", sessionId: String(agent.sessionId) } : null;
    }
    sessionIdForAgent(agentOrId) { return this.runtimeBinding(agentOrId)?.sessionId || null; }
    async setRuntimeStatus(status) { this.runtimeStatus = String(status || "idle"); return this.snapshot(); }
    async setProtocolContext(agentId, context) {
      const agent = this.agents.get(String(agentId || ""));
      if (!agent) return null;
      agent.protocolContext = context ? clone(context) : null;
      return this.getAgent(agentId);
    }
    async clearProtocolContext(agentId) { return this.setProtocolContext(agentId, null); }
    async removeAgent(agentId) {
      const id = String(agentId || "");
      const agent = this.agents.get(id);
      if (!agent) return false;
      if (agent.sessionId) this.sessions.delete(agent.sessionId);
      this.agents.delete(id);
      this.emitAgentEvent({ type: "agent-removed", agentId: id, previousState: agent.lifecycleState, at: this.clock(), role: agent.role });
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
      const agent = this.getAgentBySessionId(id);
      this.sessions.delete(id);
      if (agent) {
        const mutable = this.agents.get(agent.agentId);
        mutable.status = "OFFLINE";
        mutable.sessionId = null;
        mutable.tabId = null;
        mutable.lastError = "session_missing";
        this.transitionAgent(mutable, Lifecycle.STATES.UNAVAILABLE, { reason: "session_missing", legacyStatus: "OFFLINE" });
        this.emitAgentEvent({ type: "agent-binding-changed", agentId: mutable.agentId, binding: null, at: this.clock(), role: mutable.role });
      }
    }
    async bindAgentToSession(agentId, session, { status = "CONNECTING", chatUrl = "" } = {}) {
      const agent = this.agents.get(String(agentId || ""));
      if (!agent || !session?.id) return null;
      if (!this.sessions.has(String(session.id))) this.sessions.set(String(session.id), clone(session));
      agent.sessionId = String(session.id);
      agent.tabId = Number.isInteger(Number(session.legacyTabId)) ? Number(session.legacyTabId) : agent.tabId || 10000 + this.nextSession;
      agent.chatUrl = String(chatUrl || session.url || agent.chatUrl || "");
      agent.status = String(status || "CONNECTING");
      agent.lastError = null;
      const target = Lifecycle.stateForLegacyStatus(agent.status);
      this.transitionAgent(agent, target, {
        reason: target === Lifecycle.STATES.READY ? "prompt_ready" : target === Lifecycle.STATES.BUSY ? "prompt_active" : "runtime_starting",
        legacyStatus: agent.status,
        readinessCheckedAt: target === Lifecycle.STATES.READY ? this.clock() : null,
        explicitRecovery: agent.lifecycleState === Lifecycle.STATES.FAILED
      });
      this.emitAgentEvent({
        type: "agent-binding-changed",
        agentId: agent.agentId,
        binding: this.runtimeBinding(agent),
        at: this.clock(),
        role: agent.role
      });
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
      mutable.lastError = String(reason || "session_unavailable");
      mutable.sessionId = null;
      mutable.tabId = null;
      this.transitionAgent(mutable, Lifecycle.STATES.UNAVAILABLE, { reason: "session_missing", legacyStatus: "OFFLINE" });
      this.emitAgentEvent({ type: "agent-binding-changed", agentId: mutable.agentId, binding: null, at: this.clock(), role: mutable.role });
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
      const normalized = Lifecycle.normalizeHeartbeat(payload, { hasBinding: this.isAgentConnected(mutable) });
      mutable.lastSeenAt = this.clock();
      mutable.updatedAt = mutable.lastSeenAt;
      mutable.lastError = normalized.state === Lifecycle.STATES.UNAVAILABLE
        ? String(payload.reason || payload.error || normalized.reason)
        : null;
      mutable.chatState = {
        generating: Boolean(payload.generating),
        availability: String(payload.availability || "unknown"),
        composerOccupied: payload.composerOccupied === null || payload.composerOccupied === undefined ? null : Boolean(payload.composerOccupied),
        pathname: String(payload.pathname || "")
      };
      if (url) mutable.chatUrl = String(url);
      this.transitionAgent(mutable, normalized.state, {
        reason: normalized.reason,
        legacyStatus: normalized.legacyStatus,
        readinessCheckedAt: normalized.state === Lifecycle.STATES.READY ? mutable.lastSeenAt : null
      });
      return this.getAgent(agent.agentId);
    }
    async pingAgent(agentId) {
      const id = String(agentId || "");
      const mutable = this.agents.get(id);
      if (!this.isAgentConnected(mutable)) {
        if (mutable) this.transitionAgent(mutable, Lifecycle.STATES.UNAVAILABLE, { reason: "session_missing", legacyStatus: "OFFLINE" });
        return { ok: false, reason: "agent_offline", agentId: id, agent: this.getAgent(id) };
      }
      if (mutable.lifecycleState === Lifecycle.STATES.FAILED) {
        return { ok: false, reason: mutable.lifecycleReason || "runtime_failure", agentId: id, agent: this.getAgent(id) };
      }
      mutable.lastSeenAt = this.clock();
      this.transitionAgent(mutable, Lifecycle.STATES.READY, {
        reason: "prompt_ready",
        legacyStatus: "IDLE",
        readinessCheckedAt: mutable.lastSeenAt
      });
      return { ok: true, availability: "ready", generating: false, composerOccupied: false, agent: this.getAgent(id) };
    }
    async sendPrompt(agentId, prompt) {
      const id = String(agentId || "");
      if (!this.isAgentReady(id)) return { ok: false, reason: "agent_not_ready", agentId: id, lifecycle: this.getAgentLifecycle(id) };
      this.prompts.push({ agentId: id, prompt: String(prompt || "") });
      const response = this.responses.sendPrompt;
      const result = typeof response === "function" ? await response(id, prompt) : { ok: true, agentId: id, accepted: true };
      if (result?.ok !== false) this.transitionAgent(id, Lifecycle.STATES.BUSY, { reason: "prompt_active", legacyStatus: "BUSY" });
      return result;
    }
    async stopAgent(agentId) {
      const id = String(agentId || "");
      if (!this.isAgentConnected(id)) return { ok: false, reason: "agent_offline", agentId: id };
      this.stops.push({ agentId: id });
      const response = this.responses.stopAgent;
      const result = typeof response === "function" ? await response(id) : { ok: true, agentId: id };
      if (result?.ok !== false && this.agents.get(id)?.lifecycleState !== Lifecycle.STATES.FAILED) {
        const mutable = this.agents.get(id);
        mutable.lastSeenAt = this.clock();
        this.transitionAgent(mutable, Lifecycle.STATES.READY, {
          reason: "prompt_ready",
          legacyStatus: "IDLE",
          readinessCheckedAt: mutable.lastSeenAt
        });
      }
      return result;
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