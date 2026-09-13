(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};

  function clone(value) {
    if (typeof structuredClone === "function") return structuredClone(value);
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
  }

  class MigrationRegistry {
    constructor({ currentVersion = 1 } = {}) {
      this.currentVersion = Math.max(1, Number(currentVersion) || 1);
      this.steps = new Map();
    }

    register(fromVersion, toVersion, migrate) {
      const from = Number(fromVersion);
      const to = Number(toVersion);
      if (!Number.isInteger(from) || !Number.isInteger(to) || to !== from + 1 || typeof migrate !== "function") {
        throw new TypeError("invalid_migration_step");
      }
      if (this.steps.has(from)) throw new Error(`duplicate_migration_step:${from}`);
      this.steps.set(from, { to, migrate });
      return this;
    }

    canMigrate(fromVersion, toVersion = this.currentVersion) {
      let current = Number(fromVersion);
      const target = Number(toVersion);
      if (!Number.isInteger(current) || !Number.isInteger(target) || current > target) return false;
      while (current < target) {
        const step = this.steps.get(current);
        if (!step || step.to !== current + 1) return false;
        current = step.to;
      }
      return true;
    }

    migrate(value, { fromVersion, toVersion = this.currentVersion, context = {} } = {}) {
      let current = Number(fromVersion);
      const target = Number(toVersion);
      if (!Number.isInteger(current) || !Number.isInteger(target)) return { ok: false, reason: "migration_version_invalid" };
      if (current > target) return { ok: false, reason: "schema_from_future", fromVersion: current, toVersion: target };
      if (!this.canMigrate(current, target)) return { ok: false, reason: "migration_path_missing", fromVersion: current, toVersion: target };

      let output = clone(value);
      const applied = [];
      while (current < target) {
        const step = this.steps.get(current);
        try {
          output = step.migrate(clone(output), { ...context, fromVersion: current, toVersion: step.to });
        } catch (error) {
          return { ok: false, reason: "migration_failed", fromVersion: current, toVersion: step.to, message: error?.message || String(error) };
        }
        current = step.to;
        applied.push(current);
      }
      return { ok: true, value: output, version: current, applied };
    }
  }

  root.MigrationRegistry = MigrationRegistry;
  if (typeof module !== "undefined" && module.exports) module.exports = { MigrationRegistry };
})();
