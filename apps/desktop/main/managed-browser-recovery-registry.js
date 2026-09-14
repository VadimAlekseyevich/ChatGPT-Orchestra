"use strict";

class ManagedBrowserRecoveryRegistry {
  constructor(runtime) {
    if (!runtime?.listAgents || !runtime?.getAgent || !runtime?.isAgentConnected) throw new TypeError("managed_browser_recovery_runtime_required");
    this.runtime = runtime;
    this.compatibilityIds = new Map();
    this.nextCompatibilityId = 1;
  }

  compatibilityId(agentId) {
    const id = String(agentId || "");
    if (!this.compatibilityIds.has(id)) this.compatibilityIds.set(id, this.nextCompatibilityId++);
    return this.compatibilityIds.get(id);
  }

  recoveryAgent(agent) {
    if (!agent) return null;
    return {
      ...agent,
      // RecoveryController still uses an integer tabId as a liveness token.
      // This synthetic value is scoped to the recovery view and is never a BrowserWindow/page identity.
      tabId: this.runtime.isAgentConnected(agent) ? this.compatibilityId(agent.agentId) : null
    };
  }

  listAgents() { return this.runtime.listAgents().map((agent) => this.recoveryAgent(agent)); }
  getAgent(agentId) { return this.recoveryAgent(this.runtime.getAgent(agentId)); }
  getAgentBySessionId(sessionId) { return this.recoveryAgent(this.runtime.getAgentBySessionId?.(sessionId)); }
  getAgentByTabId(tabId) {
    const numeric = Number(tabId);
    const pair = [...this.compatibilityIds.entries()].find(([, value]) => value === numeric);
    return pair ? this.getAgent(pair[0]) : null;
  }
  isAgentConnected(agentOrId) {
    const id = typeof agentOrId === "string" ? agentOrId : agentOrId?.agentId;
    return this.runtime.isAgentConnected(id || agentOrId);
  }
  sessionIdForAgent(agentOrId) { return this.runtime.sessionIdForAgent(agentOrId); }
  runtimeBinding(agentOrId) { return this.runtime.runtimeBinding?.(agentOrId) || null; }
  setProtocolContext(agentId, context) { return this.runtime.setProtocolContext(agentId, context); }
  clearProtocolContext(agentId) { return this.runtime.clearProtocolContext(agentId); }

  async removeAgent(agentId) {
    // Keep the logical direct-browser agent so Orchestrator.createWorkers can reuse it
    // and bind a fresh page after recovery. Browser pages are not the source of truth.
    return Boolean(this.runtime.getAgent(agentId));
  }
}

module.exports = { ManagedBrowserRecoveryRegistry };
