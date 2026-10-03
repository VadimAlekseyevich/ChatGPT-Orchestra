(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};
  const Contracts = root.PlatformContracts || (typeof require === "function" ? require("./contracts.js") : null);
  const Lifecycle = root.AgentLifecycle || (typeof require === "function" ? require("./agent-lifecycle.js") : null);
  const Protocol = root.CompanionProtocol || (typeof require === "function" ? require("./companion-protocol.js") : null);

  function clone(value) {
    if (value === undefined) return undefined;
    if (typeof structuredClone === "function") return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }

  class DesktopBridgeAgentRuntime {
    constructor({ rpc, clock = () => Date.now(), readinessTtlMs = 30000 } = {}) {
      if (!rpc) throw new TypeError("desktop_bridge_rpc_required");
      this.rpc = rpc;
      this.clock = clock;
      this.readinessTtlMs = Math.max(0, Number(readinessTtlMs) || 30000);
      this.runtimeStatus = "idle";
      this.updatedAt = 0;
      this.agents = new Map();
      this.handshake = null;
      this.readyPromise = null;
      this.backgroundReadyPromise = null;
      this.lastBootstrapError = null;
      this.closed = false;
      this.hostHandlerDisposers = [];
      this.agentEventListeners = new Set();
      this.rpcEventDisposer = typeof this.rpc.onEvent === "function"
        ? this.rpc.onEvent((name, payload) => this.handleRemoteAgentEvent(name, payload))
        : null;
    }

    async bootstrap() {
      if (this.handshake) return this.snapshot();
      if (this.readyPromise) return this.readyPromise;
      this.readyPromise = (async () => {
        if (typeof this.rpc.transport?.waitForConnection === "function") await this.rpc.transport.waitForConnection();
        const handshake = await this.rpc.request("companion.handshake", {
          protocolVersion: Protocol.PROTOCOL_VERSION,
          contractVersion: Contracts.CONTRACT_VERSION,
          role: "desktop-control-plane"
        });
        Protocol.assertCompatibleVersion(handshake?.protocolVersion);
        if (Number(handshake?.contractVersion) !== Number(Contracts.CONTRACT_VERSION)) throw new Error("companion_contract_version_mismatch");
        this.handshake = clone(handshake);
        this.lastBootstrapError = null;
        this.applySnapshot(await this.rpc.request("agent.snapshot"));
        return this.snapshot();
      })();
      try {
        return await this.readyPromise;
      } finally {
        this.readyPromise = null;
      }
    }

    async ensureReady() {
      if (this.closed) throw new Error("desktop_bridge_closed");
      return this.handshake ? this.snapshot() : this.bootstrap();
    }

    async load() {
      this.closed = false;
      await this.rpc.start();
      if (typeof this.rpc.transport?.waitForConnection !== "function") return this.bootstrap();

      if (!this.backgroundReadyPromise) {
        this.backgroundReadyPromise = this.bootstrap()
          .catch((error) => {
            if (!this.closed) this.lastBootstrapError = error?.message || String(error);
            return null;
          })
          .finally(() => {
            this.backgroundReadyPromise = null;
          });
      }
      return this.snapshot();
    }

    applySnapshot(snapshot = {}) {
      this.runtimeStatus = String(snapshot.runtimeStatus || this.runtimeStatus || "idle");
      this.updatedAt = Number(snapshot.updatedAt) || this.clock();
      this.agents.clear();
      for (const [agentId, agent] of Object.entries(snapshot.agents || {})) {
        const item = clone({ ...agent, agentId: String(agent.agentId || agentId) });
        Lifecycle.initializeAgentLifecycle(item, { at: this.updatedAt });
        this.agents.set(String(agentId), item);
      }
      return this.snapshot();
    }

    upsertAgent(agent) {
      if (!agent?.agentId) return null;
      const item = clone(agent);
      Lifecycle.initializeAgentLifecycle(item, { at: this.clock() });
      this.agents.set(String(item.agentId), item);
      this.updatedAt = this.clock();
      return clone(item);
    }

    subscribeAgentEvents(listener) {
      if (typeof listener !== "function") throw new TypeError("agent_event_listener_invalid");
      this.agentEventListeners.add(listener);
      return () => this.agentEventListeners.delete(listener);
    }

    emitAgentEvent(event) {
      if (!event) return;
      const safe = clone(event);
      for (const listener of [...this.agentEventListeners]) {
        try { listener(safe); } catch (_) {}
      }
    }

    transitionCachedAgent(agentOrId, state, options = {}) {
      const agent = typeof agentOrId === "string" ? this.agents.get(agentOrId) : agentOrId;
      if (!agent) return null;
      const result = Lifecycle.transitionAgentLifecycle(agent, state, { at: this.clock(), ...options });
      if (result?.event) this.emitAgentEvent({ ...result.event, role: agent.role });
      return result;
    }

    handleRemoteAgentEvent(name, payload = {}) {
      if (!["agent-added", "agent-removed", "agent-lifecycle-changed", "agent-binding-changed"].includes(String(name || ""))) return;
      const event = clone({ ...(payload || {}), type: String(name || payload?.type || "") });
      const agentId = String(event.agentId || "");
      if (event.type === "agent-removed") {
        this.agents.delete(agentId);
      } else if (event.type === "agent-lifecycle-changed") {
        const agent = this.agents.get(agentId);
        if (agent) {
          agent.lifecycleState = Lifecycle.normalizeState(event.state);
          agent.lifecycleReason = Lifecycle.normalizeReason(event.reason, agent.lifecycleState === Lifecycle.STATES.FAILED ? "runtime_failure" : "runtime_starting");
          agent.lifecycleChangedAt = Number(event.at) || this.clock();
          if (agent.lifecycleState === Lifecycle.STATES.READY) agent.readinessCheckedAt = agent.lifecycleChangedAt;
          if (agent.lifecycleState === Lifecycle.STATES.READY) agent.status = "IDLE";
          else if (agent.lifecycleState === Lifecycle.STATES.BUSY) agent.status = "BUSY";
          else if (agent.lifecycleState === Lifecycle.STATES.FAILED) agent.status = "ERROR";
          else if (agent.status !== "OFFLINE") agent.status = "ERROR";
        }
      }
      this.updatedAt = this.clock();
      this.emitAgentEvent(event);
    }

    markAllUnavailable(reason = "transport_disconnected") {
      for (const agent of this.agents.values()) {
        agent.status = "OFFLINE";
        this.transitionCachedAgent(agent, Lifecycle.STATES.UNAVAILABLE, {
          reason: Lifecycle.normalizeReason(reason, "transport_disconnected"),
          legacyStatus: "OFFLINE",
          details: { recoverable: true, source: "bridge_transport" }
        });
      }
      this.updatedAt = this.clock();
    }

    syncTransportLifecycle() {
      let status = null;
      try { status = this.rpc?.transport?.getStatus?.() || null; }
      catch (_) { status = null; }
      if (!status || (status.connected !== false && status.peerConnected !== false)) return status;
      this.handshake = null;
      this.markAllUnavailable("transport_disconnected");
      return status;
    }

    snapshot() {
      return {
        schemaVersion: 1,
        runtimeStatus: this.runtimeStatus,
        updatedAt: this.updatedAt || this.clock(),
        agents: Object.fromEntries([...this.agents.entries()].map(([id, agent]) => [id, clone(agent)]))
      };
    }

    listAgents() {
      this.syncTransportLifecycle();
      return [...this.agents.values()].map(clone);
    }
    getAgent(agentId) {
      this.syncTransportLifecycle();
      const agent = this.agents.get(String(agentId || ""));
      return agent ? clone(agent) : null;
    }
    getAgentLifecycle(agentId) {
      this.syncTransportLifecycle();
      return Lifecycle.lifecycleForAgent(this.agents.get(String(agentId || "")));
    }
    getAgentBySessionId(sessionId) {
      const id = String(sessionId ?? "");
      const agent = [...this.agents.values()].find((item) => this.sessionIdForAgent(item) === id);
      return agent ? clone(agent) : null;
    }
    getAgentByTabId(tabId) { return this.getAgentBySessionId(tabId); }

    isAgentConnected(agentOrId) {
      this.syncTransportLifecycle();
      const agent = typeof agentOrId === "string" ? this.agents.get(agentOrId) : this.agents.get(String(agentOrId?.agentId || "")) || agentOrId;
      return Boolean(agent && this.sessionIdForAgent(agent) && agent.status !== "OFFLINE");
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
      if (sender?.kind && Object.prototype.hasOwnProperty.call(sender, "sessionId")) {
        return {
          kind: String(sender.kind || "unknown"),
          sessionId: sender.sessionId === null || sender.sessionId === undefined ? null : String(sender.sessionId),
          agentId: sender.agentId ? String(sender.agentId) : null,
          url: String(sender.url || ""),
          legacyTabId: Number.isInteger(sender.legacyTabId) ? sender.legacyTabId : null
        };
      }
      const agent = sender?.agentId ? this.getAgent(sender.agentId) : sender?.sessionId ? this.getAgentBySessionId(sender.sessionId) : null;
      return {
        kind: agent ? "agent-session" : "companion-ui",
        sessionId: agent ? this.sessionIdForAgent(agent) : sender?.sessionId || null,
        agentId: agent?.agentId || sender?.agentId || null,
        url: agent?.chatUrl || sender?.url || "",
        legacyTabId: Number.isInteger(sender?.legacyTabId) ? sender.legacyTabId : null
      };
    }

    async remote(method, payload = {}) {
      try {
        await this.ensureReady();
        return await this.rpc.request(`agent.${method}`, payload);
      } catch (error) {
        if (String(error?.message || error).includes("contract_version_mismatch")) {
          for (const agent of this.agents.values()) {
            this.transitionCachedAgent(agent, Lifecycle.STATES.FAILED, {
              reason: "runtime_incompatible",
              legacyStatus: "ERROR",
              details: { recoverable: false, terminal: true, source: "bridge_handshake" }
            });
          }
        } else {
          this.handshake = null;
          this.markAllUnavailable("transport_disconnected");
        }
        throw error;
      }
    }

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
      const agent = this.getAgentBySessionId(sessionId);
      const result = await this.remote("removeSession", { sessionId });
      if (agent) {
        const cached = this.agents.get(agent.agentId);
        cached.sessionId = null;
        cached.tabId = null;
        cached.status = "OFFLINE";
        this.transitionCachedAgent(cached, Lifecycle.STATES.UNAVAILABLE, { reason: "runtime_unavailable", legacyStatus: "OFFLINE" });
        this.emitAgentEvent({ type: "agent-binding-changed", agentId: cached.agentId, binding: null, at: this.clock(), role: cached.role });
      }
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
    async sendPrompt(agentId, prompt) {
      let agent = this.getAgent(agentId);
      if (!this.isAgentReady(agent)) {
        const refreshed = await this.pingAgent(agentId);
        agent = refreshed?.agent || this.getAgent(agentId);
        if (!refreshed?.ok || !this.isAgentReady(agent)) return { ok: false, reason: "agent_not_ready", agentId, lifecycle: this.getAgentLifecycle(agentId) };
      }
      const result = await this.remote("sendPrompt", { agentId, prompt: String(prompt || "") });
      if (result?.ok !== false && (result?.accepted === true || result?.ok === true)) {
        this.transitionCachedAgent(String(agentId || ""), Lifecycle.STATES.BUSY, { reason: "prompt_active", legacyStatus: "BUSY" });
      }
      return result;
    }
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
      this.closed = true;
      this.unbindHostHandlers();
      this.markAllUnavailable("transport_disconnected");
      await this.rpc.stop();
      this.handshake = null;
      this.readyPromise = null;
      this.backgroundReadyPromise = null;
    }
  }

  root.DesktopBridgeAgentRuntime = DesktopBridgeAgentRuntime;
  if (typeof module !== "undefined" && module.exports) module.exports = { DesktopBridgeAgentRuntime };
})();