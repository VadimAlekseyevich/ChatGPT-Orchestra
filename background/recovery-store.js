(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};
  const STORAGE_KEY = "orchestra.recovery.v1";
  const SCHEMA_VERSION = 1;
  const CONTROL_STATES = Object.freeze([
    "IDLE", "RUNNING", "PAUSING", "PAUSED", "STOPPING", "STOPPED", "RECOVERING", "RECOVERY_REQUIRED"
  ]);

  function clone(value) {
    if (typeof structuredClone === "function") return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }

  function defaultState() {
    return {
      schemaVersion: SCHEMA_VERSION,
      projectId: null,
      status: "IDLE",
      previousStatus: null,
      reason: null,
      issues: [],
      stopBoundaryActive: false,
      snapshotCursor: 0,
      snapshot: null,
      requestedAt: null,
      safePointAt: null,
      stoppedAt: null,
      resumedAt: null,
      lastReconciledAt: null,
      createdAt: 0,
      updatedAt: 0
    };
  }

  function normalizeStatus(value) {
    const status = String(value || "IDLE").toUpperCase();
    return CONTROL_STATES.includes(status) ? status : "RECOVERY_REQUIRED";
  }

  function normalizeStopBoundary(candidate, status) {
    if (candidate?.stopBoundaryActive === true) return true;
    if (["STOPPING", "STOPPED"].includes(status)) return true;
    return candidate?.previousStatus === "STOPPING" && ["RECOVERING", "RECOVERY_REQUIRED"].includes(status);
  }

  class RecoveryStore {
    constructor({ storageArea = globalThis.chrome?.storage?.local, clock = () => Date.now() } = {}) {
      this.storageArea = storageArea;
      this.clock = clock;
      this.state = defaultState();
      this.writeChain = Promise.resolve();
    }

    async load() {
      if (!this.storageArea?.get) return this.snapshot();
      const stored = await this.storageArea.get(STORAGE_KEY);
      const candidate = stored?.[STORAGE_KEY];
      if (candidate?.schemaVersion === SCHEMA_VERSION) {
        const status = normalizeStatus(candidate.status);
        this.state = {
          ...defaultState(),
          ...candidate,
          status,
          issues: Array.isArray(candidate.issues) ? clone(candidate.issues) : [],
          stopBoundaryActive: normalizeStopBoundary(candidate, status)
        };
      }
      return this.snapshot();
    }

    snapshot() { return clone(this.state); }

    summary() {
      return {
        schemaVersion: this.state.schemaVersion,
        projectId: this.state.projectId,
        status: this.state.status,
        previousStatus: this.state.previousStatus,
        reason: this.state.reason,
        issues: clone(this.state.issues),
        stopBoundaryActive: Boolean(this.state.stopBoundaryActive),
        snapshotCursor: this.state.snapshotCursor,
        snapshot: this.state.snapshot ? clone(this.state.snapshot) : null,
        requestedAt: this.state.requestedAt,
        safePointAt: this.state.safePointAt,
        stoppedAt: this.state.stoppedAt,
        resumedAt: this.state.resumedAt,
        lastReconciledAt: this.state.lastReconciledAt,
        updatedAt: this.state.updatedAt
      };
    }

    async persist() {
      this.state.updatedAt = this.clock();
      if (!this.state.createdAt) this.state.createdAt = this.state.updatedAt;
      if (!this.storageArea?.set) return this.snapshot();
      const payload = clone(this.state);
      this.writeChain = this.writeChain.catch(() => {}).then(() => this.storageArea.set({ [STORAGE_KEY]: payload }));
      await this.writeChain;
      return this.snapshot();
    }

    async attachProject(projectId, { status = "RUNNING", reason = "project_active" } = {}) {
      const id = String(projectId || "").trim();
      if (!id) return { ok: false, reason: "project_id_missing" };
      if (this.state.projectId !== id) this.state = defaultState();
      this.state.projectId = id;
      this.state.previousStatus = this.state.status;
      this.state.status = normalizeStatus(status);
      this.state.reason = reason;
      this.state.issues = [];
      if (this.state.status === "RUNNING") this.state.resumedAt = this.clock();
      await this.persist();
      return { ok: true, recovery: this.summary() };
    }

    async transition(status, { reason = null, issues = null, snapshot = undefined, reconciled = false } = {}) {
      const next = normalizeStatus(status);
      this.state.previousStatus = this.state.status;
      this.state.status = next;
      this.state.reason = reason ? String(reason) : null;
      if (issues !== null) this.state.issues = Array.isArray(issues) ? clone(issues) : [];
      const now = this.clock();
      if (["PAUSING", "STOPPING", "RECOVERING"].includes(next)) this.state.requestedAt = now;
      if (next === "STOPPING") this.state.stopBoundaryActive = true;
      if (next === "PAUSED") this.state.safePointAt = now;
      if (next === "STOPPED") this.state.stoppedAt = now;
      if (next === "RUNNING") {
        this.state.resumedAt = now;
        if (reconciled) this.state.stopBoundaryActive = false;
      }
      if (reconciled) this.state.lastReconciledAt = now;
      if (snapshot !== undefined) await this.setSnapshot(snapshot, { persist: false });
      await this.persist();
      return this.summary();
    }

    async setSnapshot(snapshot, { persist = true } = {}) {
      this.state.snapshotCursor += 1;
      this.state.snapshot = snapshot && typeof snapshot === "object" ? clone(snapshot) : null;
      if (persist) await this.persist();
      return this.summary();
    }

    async addIssue(issue) {
      if (!issue || typeof issue !== "object") return this.summary();
      this.state.issues.push(clone(issue));
      if (this.state.issues.length > 100) this.state.issues.splice(0, this.state.issues.length - 100);
      await this.persist();
      return this.summary();
    }

    async clear({ status = "IDLE" } = {}) {
      this.state = defaultState();
      this.state.status = normalizeStatus(status);
      await this.persist();
      return this.summary();
    }
  }

  root.RecoveryStore = RecoveryStore;
  root.RECOVERY_STORE_STORAGE_KEY = STORAGE_KEY;
  root.RECOVERY_SCHEMA_VERSION = SCHEMA_VERSION;
  root.RECOVERY_CONTROL_STATES = CONTROL_STATES;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { RecoveryStore, STORAGE_KEY, SCHEMA_VERSION, CONTROL_STATES, normalizeStatus, normalizeStopBoundary };
  }
})();
