(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};
  const Protocol = root.CompanionProtocol || (typeof require === "function" ? require("./companion-protocol.js") : null);
  const DEFAULT_HOST_NAME = "com.chatgptorchestra.companion";

  class NativeMessagingTransport {
    constructor({ chromeApi = globalThis.chrome, hostName = DEFAULT_HOST_NAME } = {}) {
      this.chrome = chromeApi;
      this.hostName = hostName;
      this.port = null;
      this.listeners = new Set();
      this.status = { kind: "native-messaging", hostName, connected: false, lastError: null };
      this.onMessage = (message) => {
        let frame;
        try { frame = Protocol.validateFrame(message); }
        catch (_) { return; }
        for (const listener of [...this.listeners]) listener(frame);
      };
      this.onDisconnect = () => {
        const lastError = this.chrome?.runtime?.lastError?.message || null;
        this.status = { ...this.status, connected: false, lastError };
        this.port = null;
      };
    }

    async connect() {
      if (this.port) return this.getStatus();
      const port = this.chrome?.runtime?.connectNative?.(this.hostName);
      if (!port) throw new Error("native_messaging_unavailable");
      this.port = port;
      port.onMessage?.addListener?.(this.onMessage);
      port.onDisconnect?.addListener?.(this.onDisconnect);
      this.status = { ...this.status, connected: true, lastError: null };
      return this.getStatus();
    }

    async disconnect() {
      const port = this.port;
      this.port = null;
      if (port) {
        try { port.onMessage?.removeListener?.(this.onMessage); } catch (_) {}
        try { port.onDisconnect?.removeListener?.(this.onDisconnect); } catch (_) {}
        try { port.disconnect?.(); } catch (_) {}
      }
      this.status = { ...this.status, connected: false };
      return this.getStatus();
    }

    getStatus() { return { ...this.status }; }

    subscribe(listener) {
      if (typeof listener !== "function") throw new TypeError("companion_transport_listener_invalid");
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    }

    async send(input) {
      if (!this.port) throw new Error("native_messaging_disconnected");
      this.port.postMessage(Protocol.validateFrame(input));
      return { ok: true };
    }
  }

  root.NativeMessagingTransport = NativeMessagingTransport;
  root.COMPANION_NATIVE_HOST_NAME = DEFAULT_HOST_NAME;
  if (typeof module !== "undefined" && module.exports) module.exports = { NativeMessagingTransport, DEFAULT_HOST_NAME };
})();