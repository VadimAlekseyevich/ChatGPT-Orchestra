(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};
  const Protocol = root.CompanionProtocol || (typeof require === "function" ? require("./companion-protocol.js") : null);
  const Contracts = root.PlatformContracts || (typeof require === "function" ? require("./contracts.js") : null);

  function asError(error) { return error?.message || String(error || "unknown_error"); }
  function id(prefix = "rpc") {
    const uuid = globalThis.crypto?.randomUUID?.();
    return `${prefix}-${uuid || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
  }

  class CompanionRpcPeer {
    constructor({ transport, requestTimeoutMs = 10000, logger = console } = {}) {
      this.transport = Contracts?.assertCompanionTransport ? Contracts.assertCompanionTransport(transport) : transport;
      this.requestTimeoutMs = Math.max(100, Number(requestTimeoutMs) || 10000);
      this.logger = logger;
      this.handlers = new Map();
      this.eventListeners = new Set();
      this.pending = new Map();
      this.unsubscribeTransport = null;
      this.started = false;
    }

    onRequest(method, handler) {
      const name = String(method || "").trim();
      if (!name || typeof handler !== "function") throw new TypeError("companion_rpc_handler_invalid");
      this.handlers.set(name, handler);
      return () => { if (this.handlers.get(name) === handler) this.handlers.delete(name); };
    }

    onEvent(listener) {
      if (typeof listener !== "function") throw new TypeError("companion_rpc_event_listener_invalid");
      this.eventListeners.add(listener);
      return () => this.eventListeners.delete(listener);
    }

    async start() {
      if (this.started) return this.transport.getStatus();
      this.unsubscribeTransport = this.transport.subscribe((frame) => {
        Promise.resolve(this.handleFrame(frame)).catch((error) => this.logger.warn?.("companion_rpc_frame_failed", asError(error)));
      });
      await this.transport.connect();
      this.started = true;
      return this.transport.getStatus();
    }

    async stop() {
      if (!this.started && !this.unsubscribeTransport) return;
      this.started = false;
      this.unsubscribeTransport?.();
      this.unsubscribeTransport = null;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(new Error("companion_rpc_stopped"));
      }
      this.pending.clear();
      await this.transport.disconnect();
    }

    async request(method, payload = null, { timeoutMs = this.requestTimeoutMs } = {}) {
      if (!this.started) await this.start();
      const requestId = id("req");
      const frame = Protocol.request(requestId, method, payload);
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          this.pending.delete(requestId);
          reject(new Error(`companion_rpc_timeout:${method}`));
        }, Math.max(100, Number(timeoutMs) || this.requestTimeoutMs));
        this.pending.set(requestId, { resolve, reject, timeout, method });
        Promise.resolve(this.transport.send(frame)).catch((error) => {
          clearTimeout(timeout);
          this.pending.delete(requestId);
          reject(error);
        });
      });
    }

    async notify(name, payload = null) {
      if (!this.started) await this.start();
      return this.transport.send(Protocol.event(id("evt"), name, payload));
    }

    async handleFrame(input) {
      const frame = Protocol.validateFrame(input);
      if (frame.kind === "response") {
        const pending = this.pending.get(frame.replyTo);
        if (!pending) return { ignored: true, reason: "unknown_reply" };
        clearTimeout(pending.timeout);
        this.pending.delete(frame.replyTo);
        if (frame.ok) pending.resolve(frame.result);
        else {
          const error = new Error(frame.error?.message || frame.error?.code || "companion_remote_error");
          error.code = frame.error?.code || "companion_remote_error";
          pending.reject(error);
        }
        return { ok: true };
      }

      if (frame.kind === "event") {
        for (const listener of [...this.eventListeners]) await listener(frame.event, frame.payload, frame);
        return { ok: true };
      }

      const handler = this.handlers.get(frame.method);
      if (!handler) {
        await this.transport.send(Protocol.errorResponse(frame.id, "method_not_found", frame.method));
        return { ok: false, reason: "method_not_found" };
      }
      try {
        const result = await handler(frame.payload, frame);
        await this.transport.send(Protocol.response(frame.id, result === undefined ? null : result));
        return { ok: true };
      } catch (error) {
        await this.transport.send(Protocol.errorResponse(frame.id, error?.code || "remote_handler_failed", asError(error)));
        return { ok: false, reason: error?.code || "remote_handler_failed" };
      }
    }
  }

  root.CompanionRpcPeer = CompanionRpcPeer;
  if (typeof module !== "undefined" && module.exports) module.exports = { CompanionRpcPeer };
})();