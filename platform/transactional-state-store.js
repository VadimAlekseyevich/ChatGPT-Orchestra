(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};

  function clone(value) {
    if (typeof structuredClone === "function") return structuredClone(value);
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
  }

  class TransactionalStateStore {
    constructor({ store } = {}) {
      if (!store?.get || !store?.set) throw new TypeError("transactional_state_store_backend_invalid");
      this.store = store;
      this.chain = Promise.resolve();
    }

    enqueue(operation) {
      const next = this.chain.catch(() => {}).then(operation);
      this.chain = next.then(() => undefined, () => undefined);
      return next;
    }

    async get(selector = null) {
      await this.chain.catch(() => {});
      return this.store.get(selector);
    }

    async set(values) { return this.enqueue(() => this.store.set(values || {})); }
    async remove(keys) { return this.enqueue(() => this.store.remove?.(keys)); }
    async clear() { return this.enqueue(() => this.store.clear?.()); }

    async transaction(callback) {
      if (typeof callback !== "function") throw new TypeError("transaction_callback_required");
      return this.enqueue(async () => {
        const base = await this.store.get(null);
        const staged = new Map();
        const removed = new Set();
        let cleared = false;

        const tx = {
          get: async (selector = null) => {
            const current = cleared ? {} : clone(base || {});
            for (const key of removed) delete current[key];
            for (const [key, value] of staged) current[key] = clone(value);
            if (typeof selector === "string") return { [selector]: clone(current[selector]) };
            if (Array.isArray(selector)) return Object.fromEntries(selector.map((key) => [key, clone(current[key])]));
            if (selector && typeof selector === "object") {
              return Object.fromEntries(Object.entries(selector).map(([key, fallback]) => [key, current[key] === undefined ? clone(fallback) : clone(current[key])]));
            }
            return current;
          },
          set: async (values) => {
            for (const [key, value] of Object.entries(values || {})) {
              staged.set(key, clone(value));
              removed.delete(key);
            }
          },
          remove: async (keys) => {
            for (const key of Array.isArray(keys) ? keys : [keys]) {
              if (key === null || key === undefined) continue;
              const normalized = String(key);
              removed.add(normalized);
              staged.delete(normalized);
            }
          },
          clear: async () => {
            cleared = true;
            staged.clear();
            removed.clear();
          }
        };

        const result = await callback(tx);
        if (cleared) await this.store.clear?.();
        if (removed.size) await this.store.remove?.([...removed]);
        if (staged.size) await this.store.set(Object.fromEntries(staged));
        return result;
      });
    }
  }

  root.TransactionalStateStore = TransactionalStateStore;
  if (typeof module !== "undefined" && module.exports) module.exports = { TransactionalStateStore };
})();
