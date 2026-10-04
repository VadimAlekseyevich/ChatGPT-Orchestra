(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};
  const Contracts = root.PlatformContracts || (typeof require === "function" ? require("./contracts.js") : null);
  const Protocol = root.CompanionProtocol || (typeof require === "function" ? require("./companion-protocol.js") : null);

  class ExtensionCompanionEndpoint {
    constructor({ rpc, agentRuntime } = {}) {
      if (!rpc) throw new TypeError("extension_companion_rpc_required");
      this.rpc = rpc;
      this.agentRuntime = Contracts.assertAgentRuntime(agentRuntime);
      this.disposers = [];
      this.agentEventDisposer = null;
      this.started = false;
    }

    handler(method, fn) {
      this.disposers.push(this.rpc.onRequest(method, fn));
    }

    installHandlers() {
      this.handler("companion.handshake", async (peer = {}) => {
        Protocol.assertCompatibleVersion(peer.protocolVersion);
        if (Number(peer.contractVersion) !== Number(Contracts.CONTRACT_VERSION)) throw new Error("companion_contract_version_mismatch");
        return {
          protocolVersion: Protocol.PROTOCOL_VERSION,
          contractVersion: Contracts.CONTRACT_VERSION,
          role: "extension-companion"
        };
      });
      this.handler("agent.snapshot", async () => this.agentRuntime.snapshot());
      this.handler("agent.reconcileAgents", async () => this.agentRuntime.reconcileAgents());
      this.handler("agent.openAgent", (options = {}) => this.agentRuntime.openAgent(options));
      this.handler("agent.refreshAgent", ({ agentId } = {}) => this.agentRuntime.refreshAgent(agentId));
      this.handler("agent.setRuntimeStatus", ({ status } = {}) => this.agentRuntime.setRuntimeStatus(status));
      this.handler("agent.setProtocolContext", ({ agentId, context } = {}) => this.agentRuntime.setProtocolContext(agentId, context));
      this.handler("agent.clearProtocolContext", ({ agentId } = {}) => this.agentRuntime.clearProtocolContext(agentId));
      this.handler("agent.removeAgent", ({ agentId } = {}) => this.agentRuntime.removeAgent(agentId));
      this.handler("agent.getActiveSession", () => this.agentRuntime.getActiveSession());
      this.handler("agent.getSession", ({ sessionId } = {}) => this.agentRuntime.getSession(sessionId));
      this.handler("agent.createSession", (options = {}) => this.agentRuntime.createSession(options));
      this.handler("agent.navigateSession", ({ sessionId, url } = {}) => this.agentRuntime.navigateSession(sessionId, url));
      this.handler("agent.removeSession", ({ sessionId } = {}) => this.agentRuntime.removeSession(sessionId));
      this.handler("agent.bindAgentToSession", ({ agentId, session, options } = {}) => this.agentRuntime.bindAgentToSession(agentId, session, options || {}));
      this.handler("agent.createAgentForSession", (options = {}) => this.agentRuntime.createAgentForSession(options));
      this.handler("agent.markSessionOffline", ({ sessionId, reason } = {}) => this.agentRuntime.markSessionOffline(sessionId, reason));
      this.handler("agent.updateSessionNavigation", ({ sessionId, url } = {}) => this.agentRuntime.updateSessionNavigation(sessionId, url));
      this.handler("agent.updateHeartbeat", ({ sessionId, payload, url } = {}) => this.agentRuntime.updateHeartbeat(sessionId, payload || {}, url || ""));
      if (typeof this.agentRuntime.pingAgent === "function") this.handler("agent.pingAgent", ({ agentId } = {}) => this.agentRuntime.pingAgent(agentId));
      this.handler("agent.sendPrompt", ({ agentId, prompt } = {}) => this.agentRuntime.sendPrompt(agentId, prompt));
      this.handler("agent.stopAgent", ({ agentId } = {}) => this.agentRuntime.stopAgent(agentId));
    }

    async start() {
      if (this.started) return { ok: true, alreadyStarted: true };
      this.installHandlers();
      await this.rpc.start();
      await this.agentRuntime.load();
      this.agentEventDisposer = this.agentRuntime.subscribeAgentEvents((event) => {
        const type = String(event?.type || "");
        if (!type) return;
        Promise.resolve(this.rpc.notify(type, event)).catch(() => {});
      });
      this.started = true;
      return { ok: true };
    }

    async stop() {
      this.started = false;
      this.agentEventDisposer?.();
      this.agentEventDisposer = null;
      for (const dispose of this.disposers.splice(0)) dispose();
      await this.rpc.stop();
    }

    portableSender(sender = {}) {
      if (typeof this.agentRuntime.normalizeSender === "function") return this.agentRuntime.normalizeSender(sender);
      return Contracts.normalizePortableSender(sender);
    }

    async forwardRuntimeMessage(message, sender = {}) {
      if (!this.started) throw new Error("extension_companion_not_started");
      return this.rpc.request("orchestrator.runtimeMessage", {
        message,
        sender: this.portableSender(sender)
      });
    }

    async forwardApiMessage(message, sender = {}) {
      if (!this.started) throw new Error("extension_companion_not_started");
      return this.rpc.request("orchestrator.apiMessage", {
        message,
        sender: this.portableSender(sender)
      });
    }

    async forwardSessionRemoved(sessionId) {
      if (!this.started) throw new Error("extension_companion_not_started");
      return this.rpc.request("orchestrator.sessionRemoved", { sessionId: String(sessionId ?? "") });
    }

    async forwardSessionUpdated(sessionId, changeInfo = {}, session = null) {
      if (!this.started) throw new Error("extension_companion_not_started");
      return this.rpc.request("orchestrator.sessionUpdated", {
        sessionId: String(sessionId ?? ""),
        changeInfo,
        session
      });
    }
  }

  root.ExtensionCompanionEndpoint = ExtensionCompanionEndpoint;
  if (typeof module !== "undefined" && module.exports) module.exports = { ExtensionCompanionEndpoint };
})();
