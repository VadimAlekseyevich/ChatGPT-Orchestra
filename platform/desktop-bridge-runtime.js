(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};
  const Contracts = root.PlatformContracts || (typeof require === "function" ? require("./contracts.js") : null);
  const Protocol = root.CompanionProtocol || (typeof require === "function" ? require("./companion-protocol.js") : null);

  function clone(value) {
    if (value === undefined) return undefined;
    if (typeof structuredClone === "function") return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }

  class DesktopBridgeAgentRuntime {
    constructor({ rpc, clock = () => Date.now() } = {}) {
      if (!rpc) throw new TypeError("desktop_bridge_rpc_required");
      this.rpc = rpc;
      this.clock = clock;
      this.runtimeStatus = "idle";
      this.updatedAt = 0;
      this.agents = new Map();
      this.handshake = null;
      this.hostHandlerDisposers = [];
    }

    async load() {
      await this.rpc.start();
      if (typeof this.rpc.transport?.waitForConnection === "function") await this.rpc.transport.waitForConnection();
      const handshake = await this.rpc.request("companion.handshake", {
        protocolVersion: Protocol.PROTOCOL_VERSION,
        contractVersion: Contracts.CONTRACT_VERSION,
        role: "desktop-control-plane"
      });
      Protocol.assertCompatibleVersion(handshake?.protocolVersion);
      if (Number(handshake?.contractVersion) !== Number(Contracts.CONTRACT_VERSION)) throw new Error("companion_contract_version_mismatch");
      this.handshake = clone(handshake);
      this.applySnapshot(await this.rpc.request("agent.snapshot"));
      return this.snapshot();
    }

    applySnapshot(snapshot = {}) {
      this.runtimeStatus = String(snapshot.runtimeStatus || this.runtimeStatus || "idle");
      this.updatedAt = Number(snapshot.updatedAt) || this.clock();
      this.agents.clear();
      for (const [agentId, agent] of Object.entries(snapshot.agents || {})) {
        this.agents.set(String(agentId), clone({ ...agent, agentId: String(agent.agentId || agentId) }));
      }
      return this.snapshot();
    }

    upsertAgent(agent) {
      if (!agent?.agentId) return null;
      const item = clone(agent);
      this.agents.set(String(item.agentId), item);
      this.updatedAt = this.clock();
      return clone(item);
    }

    snapshot() {
      return {
        schemaVersion: 1,
        runtimeStatus: this.runtimeStatus,
        updatedAt: this.updatedAt || this.clock(),
        agents: Object.fromEntries([...this.agents.entries()].map(([id, agent]) => [id, clone(agent)]))
      };
    }

    listAgents() { return [...this.agents.values()].map(clone); }
    getAgent(agentId) { const agent = this.agents.get(String(agentId || "")); return agent ? clone(agent) : null; }
    getAgentBySessionId(sessionId) {
      const id = String(sessionId ?? "");
      const agent = [...this.agents.values()].find((item) => this.sessionIdForAgent(item) === id);
      return agent ? clone(agent) : null;
    }
    getAgentByTabId(tabId) { return this.getAgentBySessionId(tabId); }

    isAgentConnected(agentOrId) {
      const agent = typeof agentOrId === "string" ? this.agents.get(agentOrId) : agentOrId;
      return Boolean(agent && this.sessionIdForAgent(agent) && agent.status !== "OFFLINE");
    }

    sessionIdForAgent(agentOrId) {
      const agent = typeof agentOrId === "string" ? this.agents.get(agentOrId) : agentOrId;
      if (!agent) return null;
      if (agent.sessionId !== null && agent.sessionId !== undefined) return String(agent.sessionId);
      return Number.isInteger(agent.tabId) ? String(agent.tabId) : null;
    }

    runtimeBinding(agentOrId) {
      const sessionId = this.sessionIdForAgent(agentOrId);
      return sessionId ? { kind: "extension-companion", sessionId } : null;
    }

    normalizeSender(sender = {}) {
      if (sender?.kind && Object.prototype.hasOwnProperty.call(sender, "sessionId")) return Contracts.normalizeRuntimeSender(sender);
      const agent = sender?.agentId ? this.getAgent(sender.agentId) : sender?.sessionId ? this.getAgentBySessionId(sender.sessionId) : null;
      return Contracts.normalizeRuntimeSender({
        kind: agent ? "agent-session" : "companion-ui",
        sessionId: agent ? this.sessionIdForAgent(agent) : sender?.sessionId || null,
        agentId: agent?.agentId || sender?.agentId || null,
        url: agent?.chatUrl || sender?.url || "",
        legacyTabId: Number.isInteger(sender?.legacyTabId) ? sender.legacyTabId : null
      });
    }

    async remote(method, payload = {}) { return this.rpc.request(`agent.${method}`, payload); }

    async setRuntimeStatus(status) {
      const snapshot = await this.remote("setRuntimeStatus", { status });
      return this.applySnapshot(snapshot);
    }
    async setProtocolContext(agentId, context) { return this.upsertAgent(await this.remote("setProtocolContext", { agentId, context })); }
    async clearProtocolContext(agentId) { return this.upsertAgent(await this.remote("clearProtocolContext", { agentId })); }
    async removeAgent(agentId) {
      const removed = await this.remote("removeAgent", { agentId });
      if (removed) this.agents.delete(String(agentId));
      return removed;
    }
    async getActiveSession() { return this.remote("getActiveSession"); }
    async getSession(sessionId) { return this.remote("getSession", { sessionId }); }
    async createSession(options = {}) { return this.remote("createSession", options); }
    async navigateSession(sessionId, url) { return this.remote("navigateSession", { sessionId, url }); }
    async removeSession(sessionId) {
      const result = await this.remote("removeSession", { sessionId });
      const agent = this.getAgentBySessionId(sessionId);
      if (agent) this.upsertAgent({ ...agent, status: "OFFLINE", sessionId: null, tabId: null });
      return result;
    }
    async bindAgentToSession(agentId, session, options = {}) {
      return this.upsertAgent(await this.remote("bindAgentToSession", { agentId, session, options }));
    }
    async createAgentForSession(options = {}) {
      return this.upsertAgent(await this.remote("createAgentForSession", options));
    }
    async markSessionOffline(sessionId, reason = "session_unavailable") {
      return this.upsertAgent(await this.remote("markSessionOffline", { sessionId, reason }));
    }
    async updateSessionNavigation(sessionId, url) {
      return this.upsertAgent(await this.remote("updateSessionNavigation", { sessionId, url }));
    }
    async updateHeartbeat(sessionId, payload = {}, url = "") {
      return this.upsertAgent(await this.remote("updateHeartbeat", { sessionId, payload, url }));
    }
    async pingAgent(agentId) {
      const result = await this.remote("pingAgent", { agentId });
      if (result?.agent) this.upsertAgent(result.agent);
      return result;
    }
    async sendPrompt(agentId, prompt) { return this.remote("sendPrompt", { agentId, prompt: String(prompt || "") }); }
    async stopAgent(agentId) { return this.remote("stopAgent", { agentId }); }

    bindHostHandlers({ onRuntimeMessage, onApiMessage, onSessionRemoved, onSessionUpdated } = {}) {
      this.unbindHostHandlers();
      if (typeof onRuntimeMessage === "function") {
        this.hostHandlerDisposers.push(this.rpc.onRequest("orchestrator.runtimeMessage", ({ message, sender } = {}) => onRuntimeMessage(message, this.normalizeSender(sender))));
      }
      if (typeof onApiMessage === "function") {
        this.hostHandlerDisposers.push(this.rpc.onRequest("orchestrator.apiMessage", ({ message, sender } = {}) => onApiMessage(message, this.normalizeSender(sender))));
      }
      if (typeof onSessionRemoved === "function") {
        this.hostHandlerDisposers.push(this.rpc.onRequest("orchestrator.sessionRemoved", ({ sessionId } = {}) => onSessionRemoved(String(sessionId ?? ""))));
      }
      if (typeof onSessionUpdated === "function") {
        this.hostHandlerDisposers.push(this.rpc.onRequest("orchestrator.sessionUpdated", ({ sessionId, changeInfo, session } = {}) => onSessionUpdated(String(sessionId ?? ""), changeInfo || {}, session || null)));
      }
      return () => this.unbindHostHandlers();
    }

    unbindHostHandlers() {
      for (const dispose of this.hostHandlerDisposers.splice(0)) dispose();
    }

    async close() {
      this.unbindHostHandlers();
      await this.rpc.stop();
    }
  }

  root.DesktopBridgeAgentRuntime = DesktopBridgeAgentRuntime;
  if (typeof module !== "undefined" && module.exports) module.exports = { DesktopBridgeAgentRuntime };
})();
