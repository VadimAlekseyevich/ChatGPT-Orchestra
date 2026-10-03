(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};
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
      this.runtimeStatus = "idle";
      this.nextAgent = 1;
      this.nextBindingGeneration = 1;
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
      const now = this.clock();
      const item = {
        agentId,
        role: agent.role === "lead" ? "lead" : "worker",
        label: String(agent.label || ""),
        status: String(agent.status || "IDLE"),
        protocolContext: agent.protocolContext ? clone(agent.protocolContext) : null,
        lastSeenAt: Number(agent.lastSeenAt) || now,
        lastError: agent.lastError ?? null,
        lifecycleState: agent.lifecycleState,
        lifecycleReason: agent.lifecycleReason,
        lifecycleChangedAt: agent.lifecycleChangedAt,
        readinessCheckedAt: agent.readinessCheckedAt,
        lifecycleDetails: agent.lifecycleDetails ? clone(agent.lifecycleDetails) : null,
        runtimeKind: "fake",
        bindingPresent: agent.bindingPresent !== false,
        bindingGeneration: Number(agent.bindingGeneration) || this.nextBindingGeneration++,
        createdAt: Number(agent.createdAt) || now,
        updatedAt: Number(agent.updatedAt) || now
      };
      Lifecycle.initializeAgentLifecycle(item, { at: now });
      this.agents.set(agentId, item);
      this.emitAgentEvent({ type: "agent-added", agentId, state: item.lifecycleState, reason: item.lifecycleReason, at: now, role: item.role });
      return clone(item);
    }

    async load() { return this.snapshot(); }
    snapshot() {
      return {
        schemaVersion: 1,
        runtimeKind: "fake",
        runtimeStatus: this.runtimeStatus,
        updatedAt: this.clock(),
        agents: Object.fromEntries([...this.agents].map(([id, agent]) => [id, clone(agent)]))
      };
    }
    listAgents() { return [...this.agents.values()].map(clone); }
    getAgent(agentId) {
      const agent = this.agents.get(String(agentId || ""));
      return agent ? clone(agent) : null;
    }
    getAgentLifecycle(agentId) { return Lifecycle.lifecycleForAgent(this.agents.get(String(agentId || ""))); }

    isAgentConnected(agentOrId) {
      const agent = typeof agentOrId === "string" ? this.agents.get(agentOrId) : agentOrId;
      return Boolean(agent && agent.bindingPresent !== false && agent.status !== "OFFLINE");
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

    async setRuntimeStatus(status) {
      this.runtimeStatus = String(status || "idle");
      return this.snapshot();
    }

    async setProtocolContext(agentId, context) {
      const agent = this.agents.get(String(agentId || ""));
      if (!agent) return null;
      agent.protocolContext = context ? clone(context) : null;
      agent.updatedAt = this.clock();
      return this.getAgent(agentId);
    }
    async clearProtocolContext(agentId) { return this.setProtocolContext(agentId, null); }

    async removeAgent(agentId) {
      const id = String(agentId || "");
      const agent = this.agents.get(id);
      if (!agent) return false;
      this.agents.delete(id);
      this.emitAgentEvent({ type: "agent-removed", agentId: id, previousState: agent.lifecycleState, at: this.clock(), role: agent.role });
      return true;
    }

    async disconnectAgent(agentId, reason = "transport_disconnected") {
      const mutable = this.agents.get(String(agentId || ""));
      if (!mutable) return null;
      mutable.bindingPresent = false;
      mutable.status = "OFFLINE";
      mutable.lastError = String(reason || "transport_disconnected");
      mutable.updatedAt = this.clock();
      this.transitionAgent(mutable, Lifecycle.STATES.UNAVAILABLE, {
        reason: Lifecycle.normalizeReason(reason, "transport_disconnected"),
        legacyStatus: "OFFLINE"
      });
      this.emitAgentEvent({
        type: "agent-binding-changed",
        agentId: mutable.agentId,
        runtimeKind: "fake",
        bindingPresent: false,
        at: mutable.updatedAt,
        role: mutable.role
      });
      return this.getAgent(mutable.agentId);
    }

    async recoverAgent(agentId, { status = "CONNECTING" } = {}) {
      const mutable = this.agents.get(String(agentId || ""));
      if (!mutable) return null;
      mutable.bindingPresent = true;
      mutable.bindingGeneration = this.nextBindingGeneration++;
      mutable.status = String(status || "CONNECTING");
      mutable.lastError = null;
      mutable.updatedAt = this.clock();
      this.transitionAgent(mutable, Lifecycle.STATES.UNAVAILABLE, {
        reason: "runtime_starting",
        legacyStatus: mutable.status,
        explicitRecovery: mutable.lifecycleState === Lifecycle.STATES.FAILED
      });
      this.emitAgentEvent({
        type: "agent-binding-changed",
        agentId: mutable.agentId,
        runtimeKind: "fake",
        bindingPresent: true,
        at: mutable.updatedAt,
        role: mutable.role
      });
      return this.getAgent(mutable.agentId);
    }

    async replaceRuntimeBinding(agentId) {
      const mutable = this.agents.get(String(agentId || ""));
      if (!mutable) return null;
      mutable.bindingPresent = true;
      mutable.bindingGeneration = this.nextBindingGeneration++;
      mutable.updatedAt = this.clock();
      this.emitAgentEvent({
        type: "agent-binding-changed",
        agentId: mutable.agentId,
        runtimeKind: "fake",
        bindingPresent: true,
        at: mutable.updatedAt,
        role: mutable.role
      });
      return this.getAgent(mutable.agentId);
    }

    async pingAgent(agentId) {
      const id = String(agentId || "");
      const mutable = this.agents.get(id);
      if (!this.isAgentConnected(mutable)) {
        if (mutable && mutable.lifecycleState !== Lifecycle.STATES.FAILED) {
          this.transitionAgent(mutable, Lifecycle.STATES.UNAVAILABLE, { reason: "transport_disconnected", legacyStatus: "OFFLINE" });
        }
        return { ok: false, reason: "agent_offline", agentId: id, agent: this.getAgent(id) };
      }
      if (mutable.lifecycleState === Lifecycle.STATES.FAILED) {
        return { ok: false, reason: mutable.lifecycleReason || "runtime_failure", agentId: id, agent: this.getAgent(id) };
      }
      mutable.lastSeenAt = this.clock();
      mutable.updatedAt = mutable.lastSeenAt;
      mutable.status = "IDLE";
      this.transitionAgent(mutable, Lifecycle.STATES.READY, {
        reason: "prompt_ready",
        legacyStatus: "IDLE",
        readinessCheckedAt: mutable.lastSeenAt
      });
      return { ok: true, agent: this.getAgent(id) };
    }

    async sendPrompt(agentId, prompt) {
      const id = String(agentId || "");
      if (!this.isAgentReady(id)) return { ok: false, reason: "agent_not_ready", agentId: id, lifecycle: this.getAgentLifecycle(id) };
      this.prompts.push({ agentId: id, prompt: String(prompt || "") });
      const response = this.responses.sendPrompt;
      const result = typeof response === "function" ? await response(id, prompt) : { ok: true, agentId: id, accepted: true };
      if (result?.ok !== false) {
        const mutable = this.agents.get(id);
        mutable.status = "BUSY";
        this.transitionAgent(mutable, Lifecycle.STATES.BUSY, { reason: "prompt_active", legacyStatus: "BUSY" });
      }
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
        mutable.updatedAt = mutable.lastSeenAt;
        mutable.status = "IDLE";
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
