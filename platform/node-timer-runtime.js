(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};

  class NodeTimerRuntime {
    constructor({ setIntervalFn = globalThis.setInterval, clearIntervalFn = globalThis.clearInterval, logger = console } = {}) {
      if (typeof setIntervalFn !== "function" || typeof clearIntervalFn !== "function") throw new TypeError("node_timer_functions_required");
      this.setIntervalFn = setIntervalFn;
      this.clearIntervalFn = clearIntervalFn;
      this.logger = logger;
      this.entries = new Map();
    }

    scheduleRecurring(name, { periodMinutes = 1 } = {}, listener) {
      const key = String(name || "").trim();
      if (!key || typeof listener !== "function") throw new TypeError("invalid_recurring_timer");
      this.cancel(key);
      const intervalMs = Math.max(1, Number(periodMinutes) || 1) * 60_000;
      const wrapped = () => Promise.resolve(listener({ name: key, scheduledAt: Date.now() })).catch((error) => {
        this.logger?.warn?.("[ChatGPT Orchestra] node_timer_listener_failed", key, error?.message || String(error));
      });
      const handle = this.setIntervalFn(wrapped, intervalMs);
      handle?.unref?.();
      this.entries.set(key, { handle, intervalMs, listener: wrapped });
      return () => this.cancel(key);
    }

    async cancel(name) {
      const key = String(name || "");
      const entry = this.entries.get(key);
      if (!entry) return false;
      this.entries.delete(key);
      this.clearIntervalFn(entry.handle);
      return true;
    }

    async close() {
      for (const key of [...this.entries.keys()]) await this.cancel(key);
    }

    list() {
      return [...this.entries.entries()].map(([name, entry]) => ({ name, intervalMs: entry.intervalMs }));
    }
  }

  root.NodeTimerRuntime = NodeTimerRuntime;
  if (typeof module !== "undefined" && module.exports) module.exports = { NodeTimerRuntime };
})();
