(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};

  class ExtensionDashboardTransport {
    constructor({ runtime = globalThis.chrome?.runtime, messageTypes = root.MESSAGE_TYPES } = {}) {
      this.runtime = runtime;
      this.messageTypes = messageTypes || {};
    }

    send(type, payload = {}) {
      return new Promise((resolve) => {
        if (!this.runtime?.sendMessage) return resolve({ ok: false, reason: "extension_runtime_unavailable" });
        this.runtime.sendMessage({ type, payload }, (response) => {
          const lastError = globalThis.chrome?.runtime?.lastError;
          if (lastError) return resolve({ ok: false, reason: "runtime_error", message: lastError.message });
          resolve(response || { ok: false, reason: "empty_response" });
        });
      });
    }

    query(name, payload = {}) {
      return this.send(this.messageTypes.ORCHESTRATOR_API_QUERY, { name: String(name || ""), payload });
    }

    execute(name, payload = {}) {
      return this.send(this.messageTypes.ORCHESTRATOR_API_EXECUTE, { name: String(name || ""), payload });
    }
  }

  root.ExtensionDashboardTransport = ExtensionDashboardTransport;
  if (typeof module !== "undefined" && module.exports) module.exports = { ExtensionDashboardTransport };
})();
