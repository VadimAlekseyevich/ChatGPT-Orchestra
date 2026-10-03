(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};
  const Contracts = root.PlatformContracts || (typeof require === "function" ? require("./contracts.js") : null);

  function clone(value) {
    if (value === undefined) return undefined;
    if (typeof structuredClone === "function") return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }

  function protocolContext(value) {
    if (!value || typeof value !== "object") return null;
    const output = {};
    for (const field of ["projectId", "taskId", "runId"]) {
      const item = String(value[field] || "").trim();
      if (item) output[field] = item;
    }
    return Object.keys(output).length ? output : null;
  }

  class PortableAgentRuntime {
    constructor({ runtime, runtimeKind = null } = {}) {
      if (!runtime) throw new TypeError("portable_agent_runtime_source_required");
      this.runtime = runtime;
      this.runtimeKind = String(runtimeKind || runtime?.snapshot?.()?.runtimeKind || "runtime");
      this.listenerMap = new Map();
    }

    portableAgent(agent) {
      if (!agent?.agentId) return null;
      const lifecycle = this.runtime.getAgentLifecycle?.(agent.agentId) || agent;
      return {
        agentId: String(agent.agentId),
        role: agent.role === "lead" ? "lead" : "worker",
        label: String(agent.label || ""),
        status: String(agent.status || "OFFLINE"),
        lifecycleState: lifecycle?.lifecycleState || agent.lifecycleState || "UNAVAILABLE",
        lifecycleReason: lifecycle?.lifecycleReason || agent.lifecycleReason || "runtime_unavailable",
        lifecycleChangedAt: Number(lifecycle?.lifecycleChangedAt || agent.lifecycleChangedAt) || 0,
        readinessCheckedAt: Number(lifecycle?.readinessCheckedAt || agent.readinessCheckedAt) || null,
        protocolContext: protocolContext(agent.protocolContext),
        lastSeenAt: Number(agent.lastSeenAt) || 0,
        lastError: agent.lastError ?? null,
        lifecycleDetails: agent.lifecycleDetails ? clone(agent.lifecycleDetails) : null,
        capabilities: Array.isArray(agent.capabilities) ? [...agent.capabilities] : undefined,
        executorRef: agent.executorRef ?? undefined,
        runtimeKind: this.runtimeKind,
        bindingPresent: Boolean(this.runtime.isAgentConnected?.(agent.agentId))
      };
    }

    portableResult(result, agentId = null) {
      if (!result || typeof result !== "object") return result;
      const id = String(result.agentId || result.agent?.agentId || agentId || "");
      const output = {
        ok: result.ok !== false,
        reason: result.reason || null
      };
      if (id) output.agentId = id;
      if (result.accepted !== undefined) output.accepted = Boolean(result.accepted);
      if (result.stopped !== undefined) output.stopped = Boolean(result.stopped);
      const agent = id ? this.getAgent(id) : null;
      if (agent) output.agent = agent;
      return output;
    }

    async load() { await this.runtime.load(); return this.snapshot(); }

    snapshot() {
      const raw = this.runtime.snapshot?.() || {};
      const agents = {};
      for (const agent of this.runtime.listAgents?.() || []) {
        const portable = this.portableAgent(agent);
        if (portable) agents[portable.agentId] = portable;
      }
      return {
        schemaVersion: Number(raw.schemaVersion) || 1,
        runtimeKind: this.runtimeKind,
        runtimeStatus: String(raw.runtimeStatus || "idle"),
        updatedAt: Number(raw.updatedAt) || 0,
        agents
      };
    }

    listAgents() { return (this.runtime.listAgents?.() || []).map((agent) => this.portableAgent(agent)).filter(Boolean); }
    getAgent(agentId) { return this.portableAgent(this.runtime.getAgent?.(agentId)); }
    getAgentLifecycle(agentId) { return clone(this.runtime.getAgentLifecycle?.(agentId) || null); }
    isAgentConnected(agentOrId) { return this.runtime.isAgentConnected?.(typeof agentOrId === "string" ? agentOrId : agentOrId?.agentId) === true; }
    isAgentReady(agentOrId) { return this.runtime.isAgentReady?.(typeof agentOrId === "string" ? agentOrId : agentOrId?.agentId) === true; }
    isAgentBusy(agentOrId) { return this.runtime.isAgentBusy?.(typeof agentOrId === "string" ? agentOrId : agentOrId?.agentId) === true; }
    isAgentAvailable(agentOrId) { return this.runtime.isAgentAvailable?.(typeof agentOrId === "string" ? agentOrId : agentOrId?.agentId) === true; }

    subscribeAgentEvents(listener) {
      if (typeof listener !== "function") throw new TypeError("agent_event_listener_invalid");
      const disposer = this.runtime.subscribeAgentEvents?.((event = {}) => {
        const portable = {
          type: String(event.type || ""),
          agentId: event.agentId ? String(event.agentId) : null,
          role: event.role || this.getAgent(event.agentId)?.role || null,
          previousState: event.previousState || null,
          state: event.state || null,
          reason: event.reason || null,
          at: Number(event.at) || 0
        };
        if (portable.type === "agent-binding-changed") {
          portable.runtimeKind = this.runtimeKind;
          portable.bindingPresent = Boolean(event.binding || this.runtime.isAgentConnected?.(portable.agentId));
        }
        listener(portable);
      }) || (() => {});
      this.listenerMap.set(listener, disposer);
      return () => {
        this.listenerMap.delete(listener);
        disposer();
      };
    }

    async setRuntimeStatus(status) { await this.runtime.setRuntimeStatus(status); return this.snapshot(); }
    async setProtocolContext(agentId, context) { await this.runtime.setProtocolContext(agentId, context); return this.getAgent(agentId); }
    async clearProtocolContext(agentId) { await this.runtime.clearProtocolContext(agentId); return this.getAgent(agentId); }
    async removeAgent(agentId) { return this.runtime.removeAgent(agentId); }
    async pingAgent(agentId) { return this.portableResult(await this.runtime.pingAgent(agentId), agentId); }
    async sendPrompt(agentId, prompt, options = {}) { return this.portableResult(await this.runtime.sendPrompt(agentId, prompt, options), agentId); }
    async stopAgent(agentId) { return this.portableResult(await this.runtime.stopAgent(agentId), agentId); }

    async activateAgent(agentId) {
      if (typeof this.runtime.activateAgent !== "function") return { ok: false, reason: "agent_activation_unsupported", agentId: String(agentId || "") };
      return this.portableResult(await this.runtime.activateAgent(agentId), agentId);
    }
  }

  root.PortableAgentRuntime = PortableAgentRuntime;
  if (typeof module !== "undefined" && module.exports) module.exports = { PortableAgentRuntime };
})();
