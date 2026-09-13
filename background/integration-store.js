(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};
  const STORAGE_KEY = "orchestra.integration.v1";
  const SCHEMA_VERSION = 1;
  const DEFAULTS = Object.freeze({
    maxRepairAttempts: 2,
    runTimeoutMs: 30 * 60 * 1000,
    targetPolicy: "integration_branch_only"
  });

  function clone(value) {
    if (typeof structuredClone === "function") return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }

  function defaultState() {
    return {
      schemaVersion: SCHEMA_VERSION,
      projectId: null,
      status: "IDLE",
      settings: { ...DEFAULTS },
      currentRunId: null,
      runs: {},
      order: [],
      repairTasks: {},
      repairOrder: [],
      summary: null,
      createdAt: 0,
      updatedAt: 0
    };
  }

  function normalizeSettings(value = {}) {
    return {
      maxRepairAttempts: Math.max(0, Math.min(5, Number.isFinite(Number(value.maxRepairAttempts)) ? Number(value.maxRepairAttempts) : DEFAULTS.maxRepairAttempts)),
      runTimeoutMs: Math.max(60_000, Math.min(2 * 60 * 60 * 1000, Number(value.runTimeoutMs) || DEFAULTS.runTimeoutMs)),
      targetPolicy: "integration_branch_only"
    };
  }

  class IntegrationStore {
    constructor({ storageArea = globalThis.chrome?.storage?.local, clock = () => Date.now(), idFactory = null } = {}) {
      this.storageArea = storageArea;
      this.clock = clock;
      this.idFactory = idFactory || (() => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`);
      this.state = defaultState();
      this.writeChain = Promise.resolve();
    }

    async load() {
      if (!this.storageArea?.get) return this.snapshot();
      const stored = await this.storageArea.get(STORAGE_KEY);
      const candidate = stored?.[STORAGE_KEY];
      if (candidate?.schemaVersion === SCHEMA_VERSION) {
        this.state = {
          ...defaultState(),
          ...candidate,
          settings: normalizeSettings(candidate.settings),
          runs: { ...(candidate.runs || {}) },
          order: Array.isArray(candidate.order) ? [...candidate.order] : [],
          repairTasks: { ...(candidate.repairTasks || {}) },
          repairOrder: Array.isArray(candidate.repairOrder) ? [...candidate.repairOrder] : []
        };
      }
      return this.snapshot();
    }

    snapshot() { return clone(this.state); }
    getRun(runId) { const run = this.state.runs[runId]; return run ? clone(run) : null; }
    currentRun() { return this.state.currentRunId ? this.getRun(this.state.currentRunId) : null; }
    listRuns() { return this.state.order.map((id) => this.getRun(id)).filter(Boolean); }
    listRepairs() { return this.state.repairOrder.map((id) => clone(this.state.repairTasks[id])).filter(Boolean); }

    summary() {
      const current = this.currentRun();
      const repairs = this.listRepairs();
      const repairCounts = {};
      for (const repair of repairs) repairCounts[repair.status] = (repairCounts[repair.status] || 0) + 1;
      return {
        projectId: this.state.projectId,
        status: this.state.status,
        settings: clone(this.state.settings),
        currentRunId: this.state.currentRunId,
        currentRun: current ? {
          runId: current.runId,
          status: current.status,
          agentId: current.agentId,
          branch: current.branch,
          baseSha: current.baseSha,
          targetBranch: current.targetBranch,
          repairAttempts: current.repairAttempts,
          lastEventAt: current.lastEventAt
        } : null,
        runCount: this.state.order.length,
        repairCounts,
        summary: this.state.summary ? clone(this.state.summary) : null,
        updatedAt: this.state.updatedAt
      };
    }

    async persist() {
      this.state.updatedAt = this.clock();
      if (!this.storageArea?.set) return this.snapshot();
      const payload = clone(this.state);
      this.writeChain = this.writeChain.catch(() => {}).then(() => this.storageArea.set({ [STORAGE_KEY]: payload }));
      await this.writeChain;
      return this.snapshot();
    }

    terminateActiveRepair(run, status, result, now = this.clock()) {
      if (!run?.activeRepairTaskId) return;
      const repair = this.state.repairTasks[run.activeRepairTaskId];
      if (repair && ["PENDING", "ACTIVE"].includes(repair.status)) {
        repair.status = status;
        repair.completedAt = now;
        repair.result = clone(result || {});
      }
      run.activeRepairTaskId = null;
    }

    async ensureProject(projectId, settings = {}) {
      const id = String(projectId || "").trim();
      if (!id) return { ok: false, reason: "project_id_missing" };
      if (this.state.projectId && this.state.projectId !== id) this.state = defaultState();
      if (!this.state.createdAt) this.state.createdAt = this.clock();
      this.state.projectId = id;
      this.state.settings = normalizeSettings({ ...this.state.settings, ...settings });
      await this.persist();
      return { ok: true, integration: this.summary() };
    }

    async createRun({ projectId, runId, branch, baseSha, targetBranch, taskOrder, mergeTaskIds, artifacts, verificationCommands } = {}) {
      await this.ensureProject(projectId);
      const now = this.clock();
      const run = {
        runId: String(runId || ""),
        taskId: "integration",
        agentId: null,
        status: "PENDING",
        branch: String(branch || ""),
        baseSha: String(baseSha || "").toLowerCase(),
        targetBranch: String(targetBranch || ""),
        taskOrder: [...(taskOrder || [])],
        mergeTaskIds: [...(mergeTaskIds || [])],
        artifacts: clone(artifacts || []),
        verificationCommands: [...(verificationCommands || [])],
        repairAttempts: 0,
        activeRepairTaskId: null,
        assignedAt: null,
        startedAt: null,
        lastEventAt: now,
        finishedAt: null,
        lastConflict: null,
        result: null,
        failureReason: null,
        createdAt: now,
        updatedAt: now
      };
      this.state.runs[run.runId] = run;
      this.state.order.push(run.runId);
      this.state.currentRunId = run.runId;
      this.state.status = "PENDING";
      this.state.summary = null;
      await this.persist();
      return { ok: true, run: this.getRun(run.runId) };
    }

    async assign(runId, agentId) {
      const run = this.state.runs[runId];
      if (!run || !["PENDING", "ASSIGNED"].includes(run.status)) return { ok: false, reason: "integration_run_not_pending" };
      const now = this.clock();
      run.agentId = String(agentId || "");
      run.status = "ASSIGNED";
      run.assignedAt = now;
      run.lastEventAt = now;
      run.updatedAt = now;
      this.state.status = "INTEGRATING";
      await this.persist();
      return { ok: true, run: this.getRun(runId) };
    }

    async markRunning(runId) {
      const run = this.state.runs[runId];
      if (!run) return null;
      const now = this.clock();
      run.status = "RUNNING";
      if (!run.startedAt) run.startedAt = now;
      run.lastEventAt = now;
      run.updatedAt = now;
      this.state.status = "INTEGRATING";
      await this.persist();
      return this.getRun(runId);
    }

    async touch(runId) {
      const run = this.state.runs[runId];
      if (!run) return null;
      run.lastEventAt = this.clock();
      run.updatedAt = this.clock();
      await this.persist();
      return this.getRun(runId);
    }

    async recordConflict(runId, conflict, responsibleTaskIds) {
      const run = this.state.runs[runId];
      if (!run) return null;
      const now = this.clock();
      run.status = "CONFLICT";
      run.lastEventAt = now;
      run.updatedAt = now;
      run.lastConflict = { ...clone(conflict), responsibleTaskIds: [...responsibleTaskIds], at: now };
      this.state.status = "CONFLICT";
      await this.persist();
      return this.getRun(runId);
    }

    async createRepairTask(runId, { conflict, responsibleTaskIds, nextSequence } = {}) {
      const run = this.state.runs[runId];
      if (!run) return { ok: false, reason: "integration_run_missing" };
      if (run.repairAttempts >= this.state.settings.maxRepairAttempts) return { ok: false, reason: "integration_repair_budget_exhausted" };
      const repairTaskId = `integration-repair-${this.idFactory()}`;
      const now = this.clock();
      const repair = {
        repairTaskId,
        integrationRunId: runId,
        attempt: run.repairAttempts + 1,
        status: "PENDING",
        conflict: clone(conflict || {}),
        responsibleTaskIds: [...(responsibleTaskIds || [])],
        nextSequence: Math.max(1, Number(nextSequence) || 1),
        createdAt: now,
        startedAt: null,
        completedAt: null,
        result: null
      };
      this.state.repairTasks[repairTaskId] = repair;
      this.state.repairOrder.push(repairTaskId);
      run.repairAttempts += 1;
      run.activeRepairTaskId = repairTaskId;
      run.status = "REPAIR_PENDING";
      run.updatedAt = now;
      this.state.status = "REPAIR_PENDING";
      await this.persist();
      return { ok: true, repairTask: clone(repair), run: this.getRun(runId) };
    }

    async markRepairActive(repairTaskId) {
      const repair = this.state.repairTasks[repairTaskId];
      if (!repair) return null;
      repair.status = "ACTIVE";
      repair.startedAt = this.clock();
      const run = this.state.runs[repair.integrationRunId];
      if (run) {
        run.status = "REPAIRING";
        run.lastEventAt = this.clock();
        run.updatedAt = this.clock();
      }
      this.state.status = "REPAIRING";
      await this.persist();
      return clone(repair);
    }

    async finishRepair(repairTaskId, result = {}) {
      const repair = this.state.repairTasks[repairTaskId];
      if (!repair) return null;
      repair.status = "COMPLETED";
      repair.completedAt = this.clock();
      repair.result = clone(result);
      const run = this.state.runs[repair.integrationRunId];
      if (run) run.activeRepairTaskId = null;
      await this.persist();
      return clone(repair);
    }

    async complete(runId, result) {
      const run = this.state.runs[runId];
      if (!run) return null;
      const now = this.clock();
      this.terminateActiveRepair(run, "COMPLETED", { outcome: "integration_verified" }, now);
      run.status = "VERIFIED";
      run.result = clone(result);
      run.finishedAt = now;
      run.lastEventAt = now;
      run.updatedAt = now;
      this.state.status = "INTEGRATION_VERIFIED";
      this.state.summary = clone(result);
      await this.persist();
      return this.getRun(runId);
    }

    async abandon(runId, reason) {
      const run = this.state.runs[runId];
      if (!run) return null;
      const now = this.clock();
      const normalizedReason = String(reason || "integration_abandoned");
      this.terminateActiveRepair(run, "ABANDONED", { outcome: "integration_run_abandoned", reason: normalizedReason }, now);
      run.status = "ABANDONED";
      run.failureReason = normalizedReason;
      run.finishedAt = now;
      run.updatedAt = now;
      if (this.state.currentRunId === runId) this.state.currentRunId = null;
      this.state.status = "PENDING";
      await this.persist();
      return this.getRun(runId);
    }

    async fail(runId, reason, details = null) {
      const run = this.state.runs[runId];
      if (run) {
        const now = this.clock();
        const normalizedReason = String(reason || "integration_failed");
        this.terminateActiveRepair(run, "FAILED", { outcome: "integration_run_failed", reason: normalizedReason, details: details ? clone(details) : null }, now);
        run.status = "NEEDS_USER";
        run.failureReason = normalizedReason;
        run.failureDetails = details ? clone(details) : null;
        run.finishedAt = now;
        run.updatedAt = now;
      }
      this.state.status = "NEEDS_USER";
      await this.persist();
      return run ? this.getRun(runId) : null;
    }
  }

  root.IntegrationStore = IntegrationStore;
  root.INTEGRATION_STORE_STORAGE_KEY = STORAGE_KEY;
  root.INTEGRATION_DEFAULTS = DEFAULTS;

  if (typeof module !== "undefined" && module.exports) module.exports = { IntegrationStore, STORAGE_KEY, SCHEMA_VERSION, DEFAULTS, normalizeSettings };
})();
