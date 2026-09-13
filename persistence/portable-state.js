(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};
  const PORTABLE_SCHEMA_VERSION = 1;
  const BACKUP_KEY = "orchestra.portable.backups.v1";
  const MAX_BACKUPS = 3;
  const STORE_KEYS = Object.freeze({
    projects: "orchestra.projects.v1",
    scheduler: "orchestra.scheduler.v1",
    reviews: "orchestra.reviews.v1",
    integration: "orchestra.integration.v1",
    recovery: "orchestra.recovery.v1",
    events: "orchestra.eventBus.v1",
    agents: "orchestra.tabRegistry.v1"
  });
  const ALL_STORE_KEYS = Object.freeze(Object.values(STORE_KEYS));
  const SECRET_KEYS = new Set([
    "password", "passwd", "secret", "token", "clientsecret", "accesstoken", "refreshtoken", "apikey",
    "authorization", "cookie", "cookies", "privatekey", "credentials", "credential"
  ]);
  const SECRET_VALUE = /^(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|Bearer\s+\S{20,}|-----BEGIN [^-]*PRIVATE KEY-----)/;
  const RUNTIME_BINDING_KEYS = new Set(["tabId", "legacyTabId", "sessionId", "runtimeSource"]);

  function clone(value) {
    if (typeof structuredClone === "function") return structuredClone(value);
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
  }

  function normalizeSecretKey(key) {
    return String(key || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  function redactSecrets(value) {
    if (Array.isArray(value)) return value.map(redactSecrets);
    if (value && typeof value === "object") {
      const output = {};
      for (const [key, item] of Object.entries(value)) {
        if (SECRET_KEYS.has(normalizeSecretKey(key))) output[key] = "[REDACTED]";
        else output[key] = redactSecrets(item);
      }
      return output;
    }
    if (typeof value === "string" && SECRET_VALUE.test(value.trim())) return "[REDACTED]";
    return value;
  }

  function stripRuntimeBindingsDeep(value) {
    if (Array.isArray(value)) return value.map(stripRuntimeBindingsDeep);
    if (!value || typeof value !== "object") return value;
    const output = {};
    for (const [key, item] of Object.entries(value)) {
      if (RUNTIME_BINDING_KEYS.has(key)) continue;
      if (key === "runtime" && item && typeof item === "object" && (item.sessionId !== undefined || item.legacyTabId !== undefined)) continue;
      output[key] = stripRuntimeBindingsDeep(item);
    }
    return output;
  }

  function filterProjectStore(state, projectId) {
    if (!state || typeof state !== "object") return null;
    const project = state.projects?.[projectId];
    if (!project) return null;
    return {
      ...clone(state),
      activeProjectId: projectId,
      projects: { [projectId]: clone(project) }
    };
  }

  function projectScoped(state, projectId) {
    if (!state || typeof state !== "object") return null;
    const stateProjectId = String(state.projectId || "");
    if (stateProjectId && stateProjectId !== projectId) return null;
    return clone(state);
  }

  function sanitizeEventStore(state, projectId) {
    if (!state || typeof state !== "object") return null;
    const output = clone(state);
    output.events = (Array.isArray(output.events) ? output.events : [])
      .filter((record) => record?.event?.projectId === projectId)
      .map((record) => stripRuntimeBindingsDeep(record));
    output.rejections = (Array.isArray(output.rejections) ? output.rejections : [])
      .filter((record) => record?.event?.projectId === projectId)
      .map((record) => stripRuntimeBindingsDeep(record));

    const processed = {};
    for (const [eventId, item] of Object.entries(output.processedEvents || {})) {
      if (item?.projectId === projectId) processed[eventId] = stripRuntimeBindingsDeep(item);
    }
    output.processedEvents = processed;
    output.processedOrder = (Array.isArray(output.processedOrder) ? output.processedOrder : []).filter((eventId) => Boolean(processed[eventId]));
    output.sequences = Object.fromEntries(Object.entries(output.sequences || {}).filter(([key]) => key.startsWith(`${projectId}:`)));
    return output;
  }

  function emptyPortableAgentRegistry() {
    return { schemaVersion: 1, runtimeStatus: "portable", agents: {}, updatedAt: 0 };
  }

  function importedAgentRegistry(now) {
    return { schemaVersion: 1, runtimeStatus: "idle", agents: {}, updatedAt: now };
  }

  function forceRecoveryRequired(state, projectId, now) {
    const previous = state && typeof state === "object" ? clone(state) : {};
    return {
      ...previous,
      schemaVersion: Number(previous.schemaVersion) || 1,
      projectId,
      previousStatus: previous.status || previous.previousStatus || null,
      status: "RECOVERY_REQUIRED",
      reason: "portable_import_reconciliation_required",
      issues: [{ code: "portable_import_reconciliation_required", projectId }],
      snapshot: previous.snapshot ? stripRuntimeBindingsDeep(previous.snapshot) : null,
      requestedAt: now,
      safePointAt: null,
      stoppedAt: null,
      resumedAt: null,
      lastReconciledAt: null,
      updatedAt: now
    };
  }

  function namespaceToStorage(namespaces, projectId, now) {
    return {
      [STORE_KEYS.projects]: clone(namespaces.projects),
      [STORE_KEYS.scheduler]: clone(namespaces.scheduler),
      [STORE_KEYS.reviews]: clone(namespaces.reviews),
      [STORE_KEYS.integration]: clone(namespaces.integration),
      [STORE_KEYS.recovery]: forceRecoveryRequired(namespaces.recovery, projectId, now),
      [STORE_KEYS.events]: clone(namespaces.events),
      [STORE_KEYS.agents]: importedAgentRegistry(now)
    };
  }

  class PortableStateManager {
    constructor({ stateStore, migrations = null, clock = () => Date.now(), maxBackups = MAX_BACKUPS } = {}) {
      this.stateStore = stateStore;
      this.migrations = migrations || null;
      this.clock = clock;
      this.maxBackups = Math.max(1, Number(maxBackups) || MAX_BACKUPS);
    }

    async capture({ projectId = null } = {}) {
      if (!this.stateStore?.get) return { ok: false, reason: "state_store_unavailable" };
      const raw = await this.stateStore.get(ALL_STORE_KEYS);
      const projects = raw?.[STORE_KEYS.projects];
      const id = String(projectId || projects?.activeProjectId || "").trim();
      if (!id) return { ok: false, reason: "portable_project_id_missing" };
      const projectState = filterProjectStore(projects, id);
      if (!projectState) return { ok: false, reason: "portable_project_not_found", projectId: id };

      const namespaces = {
        projects: projectState,
        scheduler: projectScoped(raw?.[STORE_KEYS.scheduler], id),
        reviews: projectScoped(raw?.[STORE_KEYS.reviews], id),
        integration: projectScoped(raw?.[STORE_KEYS.integration], id),
        recovery: stripRuntimeBindingsDeep(projectScoped(raw?.[STORE_KEYS.recovery], id)),
        events: sanitizeEventStore(raw?.[STORE_KEYS.events], id),
        agents: emptyPortableAgentRegistry()
      };
      const snapshot = redactSecrets({
        schemaVersion: PORTABLE_SCHEMA_VERSION,
        projectId: id,
        capturedAt: this.clock(),
        namespaces
      });
      return { ok: true, snapshot };
    }

    validate(snapshot) {
      if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return { ok: false, reason: "portable_state_not_object" };
      const version = Number(snapshot.schemaVersion);
      if (!Number.isInteger(version) || version < 1) return { ok: false, reason: "portable_schema_version_invalid" };
      if (version > PORTABLE_SCHEMA_VERSION) return { ok: false, reason: "portable_schema_from_future", schemaVersion: version };
      const projectId = String(snapshot.projectId || "").trim();
      if (!projectId) return { ok: false, reason: "portable_project_id_missing" };
      if (!snapshot.namespaces || typeof snapshot.namespaces !== "object" || Array.isArray(snapshot.namespaces)) return { ok: false, reason: "portable_namespaces_missing" };
      if (!snapshot.namespaces.projects?.projects?.[projectId]) return { ok: false, reason: "portable_project_payload_missing" };
      return { ok: true, schemaVersion: version, projectId };
    }

    migrate(snapshot) {
      const checked = this.validate(snapshot);
      if (!checked.ok) return checked;
      if (checked.schemaVersion === PORTABLE_SCHEMA_VERSION) return { ok: true, snapshot: clone(snapshot), applied: [] };
      if (!this.migrations?.migrate) return { ok: false, reason: "portable_migration_registry_missing" };
      const result = this.migrations.migrate(snapshot, {
        fromVersion: checked.schemaVersion,
        toVersion: PORTABLE_SCHEMA_VERSION,
        context: { kind: "portable_state" }
      });
      if (!result.ok) return result;
      const migrated = result.value;
      migrated.schemaVersion = PORTABLE_SCHEMA_VERSION;
      const rechecked = this.validate(migrated);
      return rechecked.ok ? { ok: true, snapshot: migrated, applied: result.applied || [] } : rechecked;
    }

    async createBackup(transactionStore, reason = "portable_import") {
      const current = await transactionStore.get([...ALL_STORE_KEYS, BACKUP_KEY]);
      const backups = Array.isArray(current?.[BACKUP_KEY]) ? clone(current[BACKUP_KEY]) : [];
      const storage = {};
      for (const key of ALL_STORE_KEYS) {
        if (current?.[key] !== undefined) storage[key] = clone(current[key]);
      }
      const backup = {
        backupId: `backup-${this.clock()}`,
        createdAt: this.clock(),
        reason,
        storage
      };
      backups.push(backup);
      while (backups.length > this.maxBackups) backups.shift();
      await transactionStore.set({ [BACKUP_KEY]: backups });
      return backup;
    }

    async import(snapshot, { replace = false, freezeAfter = false } = {}) {
      if (!this.stateStore?.transaction) return { ok: false, reason: "state_store_transaction_required" };
      const migrated = this.migrate(snapshot);
      if (!migrated.ok) return migrated;
      const portable = redactSecrets(migrated.snapshot);
      const projectId = portable.projectId;
      const now = this.clock();

      let result = null;
      await this.stateStore.transaction(async (tx) => {
        const existing = await tx.get(STORE_KEYS.projects);
        const activeProjectId = String(existing?.[STORE_KEYS.projects]?.activeProjectId || "");
        if (activeProjectId && activeProjectId !== projectId && !replace) {
          const error = new Error("portable_destination_has_active_project");
          error.code = "portable_destination_has_active_project";
          throw error;
        }
        const backup = await this.createBackup(tx, "portable_import");
        const storage = namespaceToStorage(portable.namespaces, projectId, now);
        await tx.set(storage);
        result = { backupId: backup.backupId, projectId, appliedMigrations: migrated.applied || [] };
      }, { freezeAfter }).catch((error) => {
        result = { error: error?.code || error?.message || "portable_import_failed" };
      });
      if (result?.error) return { ok: false, reason: result.error };
      return { ok: true, ...result, recoveryRequired: true };
    }
  }

  root.PortableState = {
    PORTABLE_SCHEMA_VERSION,
    STORE_KEYS,
    ALL_STORE_KEYS,
    BACKUP_KEY,
    redactSecrets,
    stripRuntimeBindingsDeep,
    PortableStateManager
  };

  if (typeof module !== "undefined" && module.exports) module.exports = root.PortableState;
})();
