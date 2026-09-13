(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};
  const RECONNECT_TIMER = "orchestra-companion-reconnect";

  function asError(error) { return error?.message || String(error || "unknown_error"); }

  class ExtensionCompanionController {
    constructor({ endpoint, timerRuntime, reconnectPeriodMinutes = 1, logger = console } = {}) {
      if (!endpoint) throw new TypeError("companion_endpoint_required");
      root.PlatformContracts?.assertTimerRuntime?.(timerRuntime);
      this.endpoint = endpoint;
      this.timerRuntime = timerRuntime;
      this.reconnectPeriodMinutes = Math.max(1, Number(reconnectPeriodMinutes) || 1);
      this.logger = logger;
      this.desired = false;
      this.reconnectCancel = null;
      this.connectPromise = null;
      this.lastConnectedAt = 0;
      this.lastError = null;
    }

    transportStatus() {
      return this.endpoint?.rpc?.transport?.getStatus?.() || { connected: false };
    }

    getStatus() {
      const transport = this.transportStatus();
      return {
        mode: "companion",
        desired: this.desired,
        connected: Boolean(transport.connected && this.endpoint.started),
        transport,
        lastConnectedAt: this.lastConnectedAt,
        lastError: this.lastError
      };
    }

    scheduleReconnect() {
      if (this.reconnectCancel || !this.timerRuntime) return;
      this.reconnectCancel = this.timerRuntime.scheduleRecurring(
        RECONNECT_TIMER,
        { periodMinutes: this.reconnectPeriodMinutes },
        () => this.ensureConnected("reconnect_timer")
      );
    }

    async start() {
      this.desired = true;
      this.scheduleReconnect();
      return this.ensureConnected("startup");
    }

    async ensureConnected(reason = "manual") {
      if (!this.desired) return { ok: false, reason: "companion_mode_stopped", status: this.getStatus() };
      if (this.transportStatus().connected && this.endpoint.started) return { ok: true, alreadyConnected: true, status: this.getStatus() };
      if (this.connectPromise) return this.connectPromise;

      this.connectPromise = (async () => {
        try {
          if (this.endpoint.started || this.endpoint.disposers?.length) await this.endpoint.stop();
          await this.endpoint.start();
          this.lastConnectedAt = Date.now();
          this.lastError = null;
          return { ok: true, reason, status: this.getStatus() };
        } catch (error) {
          this.lastError = asError(error);
          this.logger.warn?.("[ChatGPT Orchestra] companion_connect_failed", reason, this.lastError);
          try { await this.endpoint.stop(); } catch (_) {}
          return { ok: false, reason: "companion_connect_failed", message: this.lastError, status: this.getStatus() };
        } finally {
          this.connectPromise = null;
        }
      })();
      return this.connectPromise;
    }

    async stop() {
      this.desired = false;
      try { await this.reconnectCancel?.(); } catch (_) {}
      this.reconnectCancel = null;
      try { await this.timerRuntime?.cancel?.(RECONNECT_TIMER); } catch (_) {}
      await this.endpoint.stop();
      return { ok: true, status: this.getStatus() };
    }
  }

  root.ExtensionCompanionController = ExtensionCompanionController;
  root.COMPANION_RECONNECT_TIMER = RECONNECT_TIMER;
  if (typeof module !== "undefined" && module.exports) module.exports = { ExtensionCompanionController, RECONNECT_TIMER };
})();