const test = require("node:test");
const assert = require("node:assert/strict");
const { RecoveryStore } = require("../background/recovery-store.js");
const { RecoveryController } = require("../background/recovery-controller.js");

function fakeStorage() {
  const data = {};
  return { async get(key) { return { [key]: data[key] }; }, async set(values) { Object.assign(data, values); } };
}

function fixtures() {
  const activeRuns = [{ runId: "R1", taskId: "T1", agentId: "A1" }];
  const activeReviews = [];
  const agents = new Map([["A1", { agentId: "A1", role: "worker", status: "BUSY", tabId: 1, protocolContext: { projectId: "P1", taskId: "T1", runId: "R1" } }]]);
  const projectStore = {
    summary() { return { projectId: "P1", status: "RUNNING", stage: "EXECUTION" }; },
    getActiveProject() { return { projectId: "P1", status: "RUNNING" }; }
  };
  const schedulerStore = {
    activeRuns() { return activeRuns.map((item) => ({ ...item })); },
    summary() { return { projectId: "P1", status: "RUNNING", taskCount: 1, settings: { maxWorkers: 3 } }; }
  };
  const reviewStore = {
    active() { return activeReviews.map((item) => ({ ...item })); },
    summary() { return { projectId: "P1", pending: 0, active: activeReviews.length }; }
  };
  const integrationStore = {
    currentRun() { return null; },
    summary() { return { projectId: "P1", status: "IDLE" }; }
  };
  const registry = {
    listAgents() { return [...agents.values()].map((agent) => ({ ...agent })); },
    getAgent(id) { const value = agents.get(id); return value ? { ...value } : null; },
    isAgentConnected(agentOrId) {
      const value = typeof agentOrId === "string" ? agents.get(agentOrId) : agentOrId;
      return Boolean(value && !["OFFLINE", "ERROR"].includes(value.status));
    },
    async setProtocolContext(id, context) { const value = agents.get(id); if (value) value.protocolContext = context; return value; },
    async clearProtocolContext(id) { const value = agents.get(id); if (value) value.protocolContext = null; return value; },
    async removeAgent(id) { return agents.delete(id); }
  };
  const planningEngine = {
    hasActiveGeneration() { return false; },
    getLead() { return null; },
    async interruptForRecovery() { return { ok: true }; },
    async resumeAfterRecovery() { return { ok: true }; }
  };
  const schedulerEngine = {
    async interruptActiveRuns() { activeRuns.splice(0); return { ok: true, interrupted: ["R1"] }; },
    async reconcileForResume() { return { ok: true, issues: [] }; },
    async tick() { return { ok: true }; }
  };
  const reviewEngine = {
    async interruptForRecovery() { activeReviews.splice(0); return { ok: true }; },
    async reconcileForResume() { return { ok: true, issues: [] }; },
    async tick() { return { ok: true }; }
  };
  const integrationEngine = {
    async interruptForRecovery() { return { ok: true, ignored: true }; },
    async reconcileForResume() { return { ok: true }; },
    async tick() { return { ok: true }; }
  };
  return { activeRuns, agents, projectStore, schedulerStore, reviewStore, integrationStore, registry, planningEngine, schedulerEngine, reviewEngine, integrationEngine };
}

function controllerFrom(fx, { bootReady = true } = {}) {
  const store = new RecoveryStore({ storageArea: fakeStorage(), clock: (() => { let n = 100; return () => ++n; })() });
  const controller = new RecoveryController({ store, ...fx });
  controller.bootReady = bootReady;
  return { store, controller };
}

test("boot gate blocks prompt dispatch until runtime reconciliation completes", async () => {
  const fx = fixtures();
  const { store, controller } = controllerFrom(fx, { bootReady: false });
  assert.equal(controller.canDispatchNewPrompts(), false);
  await controller.prepareForBoot();
  assert.equal(controller.canDispatchNewPrompts(), false);
  await controller.afterRuntimeInit();
  assert.equal(store.summary().status, "RUNNING");
  assert.equal(controller.canDispatchNewPrompts(), true);
});

test("Pause waits for active work and only then reaches PAUSED safe point", async () => {
  const fx = fixtures();
  const { store, controller } = controllerFrom(fx);
  await store.load();
  await store.attachProject("P1", { status: "RUNNING" });
  const requested = await controller.pause();
  assert.equal(requested.ok, true);
  assert.equal(store.summary().status, "PAUSING");
  assert.equal(controller.getPublicState().safePoint.reached, false);

  fx.activeRuns.splice(0);
  await controller.tick({ reason: "worker_done" });
  assert.equal(store.summary().status, "PAUSED");
  assert.equal(controller.getPublicState().safePoint.reached, true);
});

test("Stop Now blocks dispatch, stops agents and persists STOPPED snapshot", async () => {
  const fx = fixtures();
  const { store, controller } = controllerFrom(fx);
  await store.load();
  await store.attachProject("P1", { status: "RUNNING" });
  const stoppedAgents = [];
  controller.setActions({ stopAgent: async (agentId) => { stoppedAgents.push(agentId); return { ok: true }; } });
  const result = await controller.stopNow();
  assert.equal(result.ok, true);
  assert.equal(store.summary().status, "STOPPED");
  assert.deepEqual(stoppedAgents, ["A1"]);
  assert.equal(fx.activeRuns.length, 0);
  assert.equal(controller.canDispatchNewPrompts(), false);
});

test("Resume reconciles before opening dispatch gate", async () => {
  const fx = fixtures();
  fx.activeRuns.splice(0);
  const { store, controller } = controllerFrom(fx);
  await store.load();
  await store.attachProject("P1", { status: "STOPPED" });
  const order = [];
  controller.setActions({
    reconcileTabs: async () => { order.push("tabs"); },
    createWorkers: async () => { order.push("workers"); return { ok: true }; }
  });
  fx.schedulerEngine.reconcileForResume = async () => { order.push("scheduler"); return { ok: true, issues: [] }; };
  fx.reviewEngine.reconcileForResume = async () => { order.push("reviews"); return { ok: true, issues: [] }; };
  fx.integrationEngine.reconcileForResume = async () => { order.push("integration"); return { ok: true }; };
  fx.planningEngine.resumeAfterRecovery = async () => { order.push("planning-kick"); return { ok: true }; };
  fx.reviewEngine.tick = async () => { order.push("review-kick"); };
  fx.schedulerEngine.tick = async () => { order.push("scheduler-kick"); };
  fx.integrationEngine.tick = async () => { order.push("integration-kick"); };

  const result = await controller.resume();
  assert.equal(result.ok, true);
  assert.equal(store.summary().status, "RUNNING");
  assert.equal(controller.canDispatchNewPrompts(), true);
  assert.deepEqual(order.slice(0, 5), ["tabs", "workers", "scheduler", "reviews", "integration"]);
  assert.ok(order.indexOf("scheduler-kick") > order.indexOf("integration"));
});

test("Resume removes offline worker identities before creating replacement tabs", async () => {
  const fx = fixtures();
  fx.activeRuns.splice(0);
  fx.agents.set("A-old", { agentId: "A-old", role: "worker", status: "OFFLINE", tabId: null, protocolContext: null });
  const { store, controller } = controllerFrom(fx);
  await store.load();
  await store.attachProject("P1", { status: "STOPPED" });
  let observedOldIdentity = null;
  controller.setActions({
    reconcileTabs: async () => {},
    createWorkers: async () => {
      observedOldIdentity = fx.agents.has("A-old");
      fx.agents.set("A-new", { agentId: "A-new", role: "worker", status: "CONNECTING", tabId: 20, protocolContext: null });
      return { ok: true, created: ["A-new"] };
    }
  });
  const result = await controller.resume();
  assert.equal(result.ok, true);
  assert.equal(observedOldIdentity, false);
  assert.equal(fx.agents.has("A-old"), false);
  assert.equal(fx.agents.has("A-new"), true);
});


test("boot reevaluates persisted RECOVERY_REQUIRED and clears it when continuity is healthy", async () => {
  const fx = fixtures();
  fx.activeRuns.splice(0);
  const { store, controller } = controllerFrom(fx, { bootReady: false });
  await store.load();
  await store.attachProject("P1", { status: "RECOVERY_REQUIRED", reason: "transient_restart_gap" });
  assert.equal(store.summary().status, "RECOVERY_REQUIRED");

  await controller.prepareForBoot();
  assert.equal(store.summary().status, "RECOVERING");
  assert.equal(controller.canDispatchNewPrompts(), false);

  const result = await controller.afterRuntimeInit();
  assert.equal(result.status, "RUNNING");
  assert.equal(store.summary().status, "RUNNING");
  assert.equal(controller.canDispatchNewPrompts(), true);
});
