(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};

  class RuntimeMessenger {
    constructor({ runtime = globalThis.chrome?.runtime, logger = root.Logger } = {}) {
      this.runtime = runtime;
      this.logger = logger;
    }

    send(type, payload = {}) {
      if (!this.runtime?.sendMessage) return;
      try {
        this.runtime.sendMessage({ type, payload }, () => {
          void this.runtime?.lastError;
        });
      } catch (error) {
        this.logger?.debug?.("runtime_message_skipped", {
          type,
          message: error?.message || String(error)
        });
      }
    }

    request(type, payload = {}) {
      if (!this.runtime?.sendMessage) return Promise.resolve(null);
      return new Promise((resolve) => {
        try {
          this.runtime.sendMessage({ type, payload }, (response) => {
            if (this.runtime?.lastError) {
              this.logger?.debug?.("runtime_request_failed", {
                type,
                message: this.runtime.lastError.message
              });
              resolve(null);
              return;
            }
            resolve(response || null);
          });
        } catch (error) {
          this.logger?.debug?.("runtime_request_skipped", {
            type,
            message: error?.message || String(error)
          });
          resolve(null);
        }
      });
    }
  }

  root.RuntimeMessenger = RuntimeMessenger;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = RuntimeMessenger;
  }
})();
