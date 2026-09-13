(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};
  const Protocol = root.CompanionProtocol || (typeof require === "function" ? require("./companion-protocol.js") : null);

  function clone(value) {
    if (typeof structuredClone === "function") return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }

  class LoopbackCompanionTransport {
    constructor({ name = "loopback" } = {}) {
      this.name = name;
      this.peer = null;
      this.listeners = new Set();
      this.connected = false;
    }

    pair(peer) { this.peer = peer; return this; }

    async connect() {
      this.connected = true;
      return this.getStatus();
    }

    async disconnect() {
      this.connected = false;
      return this.getStatus();
    }

    getStatus() {
      return { kind: "loopback", name: this.name, connected: this.connected, peerConnected: Boolean(this.peer?.connected) };
    }

    subscribe(listener) {
      if (typeof listener !== "function") throw new TypeError("companion_transport_listener_invalid");
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    }

    async send(input) {
      if (!this.connected) throw new Error("companion_transport_disconnected");
      if (!this.peer?.connected) throw new Error("companion_peer_disconnected");
      const frame = Protocol.validateFrame(input);
      queueMicrotask(() => this.peer.deliver(clone(frame)));
      return { ok: true };
    }

    deliver(frame) {
      for (const listener of [...this.listeners]) listener(clone(frame));
    }
  }

  function createLoopbackCompanionPair() {
    const desktop = new LoopbackCompanionTransport({ name: "desktop" });
    const extension = new LoopbackCompanionTransport({ name: "extension" });
    desktop.pair(extension);
    extension.pair(desktop);
    return { desktop, extension };
  }

  root.LoopbackCompanionTransport = LoopbackCompanionTransport;
  root.createLoopbackCompanionPair = createLoopbackCompanionPair;
  if (typeof module !== "undefined" && module.exports) module.exports = { LoopbackCompanionTransport, createLoopbackCompanionPair };
})();