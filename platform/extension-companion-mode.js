(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};
  const NativeMessagingTransport = root.NativeMessagingTransport || (typeof require === "function" ? require("./native-messaging-transport.js").NativeMessagingTransport : null);
  const CompanionRpcPeer = root.CompanionRpcPeer || (typeof require === "function" ? require("./companion-rpc.js").CompanionRpcPeer : null);
  const ExtensionCompanionEndpoint = root.ExtensionCompanionEndpoint || (typeof require === "function" ? require("./extension-companion-endpoint.js").ExtensionCompanionEndpoint : null);

  const COMPANION_MODE_KEY = "orchestraCompanionModeV1";
  const LEGACY_PROJECTS_KEY = "orchestra.projects.v1";
  const RECONNECT_TIMER = "orchestra-companion-reconnect";

  class ExtensionCompanionModeController {
    constructor({
      chromeApi = globalThis.chrome,
      storageArea = globalThis.chrome?.storage?.local,
      agentRuntime,
      timerRuntime,
      transportFactory = null,
      rpcFactory = null,
      endpointFactory = null,
      logger = console
    } = {}) {
      if (!agentRuntime) throw new TypeError("companion_mode_agent_runtime_required");
      if (!timerRuntime) throw new TypeError("companion_mode_timer_runtime_required");
      this.chrome = chromeApi;
      this.storageArea = storageArea;
      this.agentRuntime = agentRuntime;
      this.timerRuntime = timerRuntime;
      this.transportFactory = transportFactory || (() => new NativeMessagingTransport({ chromeApi: this.chrome }));
      this.rpcFactory = rpcFactory || ((transport) => new CompanionRpcPeer({ transport, logger: this.logger }));
      this.endpointFactory = endpointFactory || ((rpc) => new ExtensionCompanionEndpoint({ rpc, agentRuntime: this.agentRuntime }));
      this.logger = logger;
      this.enabled = false;
      this.transport = null;
      this.rpc = null;
      this.endpoint = null;
      this.reconnectCancel = null;
      this.connectPromise = null;
      this.lastError = null;
    }

    async load() {
      const stored = await this.storageArea?.get?.(COMPANION_MODE_KEY);
      this.enabled = stored?.[COMPANION_MODE_KEY] === true;
      if (this.enabled) {
        this.startReconnectTimer();
        await this.ensureConnected({ throwOnFailure: false });
      }
      return this.getStatus();
    }

    isEnabled() { return this.enabled === true; }

    getStatus() {
      const transport = this.transport?.getStatus?.() || null;
      return {
        enabled: this.enabled,
        state: !this.enabled ? "DISABLED" : transport?.connected ? "CONNECTED" : this.connectPromise ? "CONNECTING" : "DISCONNECTED",
        connected: Boolean(this.enabled && transport?.connected),
        transport,
        lastError: this.lastError
      };
    }

    async legacyProjectGuard() {
      const stored = await this.storageArea?.get?.(LEGACY_PROJECTS_KEY);
      const state = stored?.[LEGACY_PROJECTS_KEY];
      const activeProjectId = state?.activeProjectId ? String(state.activeProjectId) : null;
      if (!activeProjectId) return { ok: true };
      return { ok: false, reason: "companion_enable_requires_project_migration", activeProjectId };
    }

    async persistEnabled() {
      await this.storageArea?.set?.({ [COMPANION_MODE_KEY]: this.enabled === true });
    }

    startReconnectTimer() {
      if (this.reconnectCancel) return;
      this.reconnectCancel = this.timerRuntime.scheduleRecurring(RECONNECT_TIMER, { periodMinutes: 1 }, () => {
        if (!this.enabled) return null;
        return this.ensureConnected({ throwOnFailure: false });
      });
    }

    async stopReconnectTimer() {
      const cancel = this.reconnectCancel;
      this.reconnectCancel = null;
      if (cancel) await cancel();
      else await this.timerRuntime.cancel?.(RECONNECT_TIMER);
    }

    async teardownEndpoint() {
      const endpoint = this.endpoint;
      this.endpoint = null;
      this.rpc = null;
      this.transport = null;
      if (endpoint) {
        try { await endpoint.stop(); }
        catch (error) { this.logger.warn?.("companion_endpoint_stop_failed", error?.message || String(error)); }
      }
    }

    async ensureConnected({ throwOnFailure = true } = {}) {
      if (!this.enabled) return this.getStatus();
      if (this.transport?.getStatus?.()?.connected && this.endpoint?.started) return this.getStatus();
      if (this.connectPromise) return this.connectPromise;

      this.connectPromise = (async () => {
        await this.teardownEndpoint();
        try {
          const transport = this.transportFactory();
          const rpc = this.rpcFactory(transport);
          const endpoint = this.endpointFactory(rpc);
          this.transport = transport;
          this.rpc = rpc;
          this.endpoint = endpoint;
          await endpoint.start();
          this.lastError = null;
          return this.getStatus();
        } catch (error) {
          this.lastError = error?.message || String(error);
          await this.teardownEndpoint();
          if (throwOnFailure) throw error;
          return this.getStatus();
        } finally {
          this.connectPromise = null;
        }
      })();
      return this.connectPromise;
    }

    async setEnabled(enabled) {
      const requested = enabled === true;
      if (requested && !this.enabled) {
        const guard = await this.legacyProjectGuard();
        if (!guard.ok) return { ...this.getStatus(), ...guard, enableRejected: true };
      }

      this.enabled = requested;
      await this.persistEnabled();
      if (!this.enabled) {
        await this.stopReconnectTimer();
        await this.teardownEndpoint();
        this.lastError = null;
        return this.getStatus();
      }
      this.startReconnectTimer();
      return this.ensureConnected({ throwOnFailure: false });
    }

    async reconnect() {
      if (!this.enabled) return this.getStatus();
      await this.teardownEndpoint();
      return this.ensureConnected({ throwOnFailure: false });
    }

    async close() {
      await this.stopReconnectTimer();
      await this.teardownEndpoint();
    }

    async forwardRuntimeMessage(message, sender) {
      await this.ensureConnected();
      return this.endpoint.forwardRuntimeMessage(message, sender);
    }

    async forwardSessionRemoved(sessionId) {
      await this.ensureConnected();
      return this.endpoint.forwardSessionRemoved(sessionId);
    }

    async forwardSessionUpdated(sessionId, changeInfo, session) {
      await this.ensureConnected();
      return this.endpoint.forwardSessionUpdated(sessionId, changeInfo, session);
    }

    async forwardApiMessage(message, sender) {
      await this.ensureConnected();
      return this.endpoint.forwardApiMessage(message, sender);
    }
  }

  root.ExtensionCompanionModeController = ExtensionCompanionModeController;
  root.COMPANION_MODE_KEY = COMPANION_MODE_KEY;
  root.COMPANION_RECONNECT_TIMER = RECONNECT_TIMER;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { ExtensionCompanionModeController, COMPANION_MODE_KEY, LEGACY_PROJECTS_KEY, RECONNECT_TIMER };
  }
})();
