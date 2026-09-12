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
          // Phase 1 has no background listener yet. Reading lastError prevents
          // the expected "receiving end does not exist" warning from leaking.
          void this.runtime?.lastError;
        });
      } catch (error) {
        this.logger?.debug?.("runtime_message_skipped", {
          type,
          message: error?.message || String(error)
        });
      }
    }
  }

  root.RuntimeMessenger = RuntimeMessenger;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = RuntimeMessenger;
  }
})();
