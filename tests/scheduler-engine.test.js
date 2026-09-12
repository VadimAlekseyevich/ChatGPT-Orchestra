const test = require("node:test");
const assert = require("node:assert/strict");

require("../background/conflict-policy.js");
require("../prompts/worker-prompts.js");
const { SchedulerStore } = require("../background/scheduler-store.js");
const { SchedulerEngine } = require("../background/scheduler-engine.js");

function fakeStorage() {
  const data = {};
  return {
    data,
    async get(key) { return { [key]: data[key] }; },
    async set(values) { Object.assign(data, values); }
  };
}

class FakeEventBus {
  constructor() { this.listeners = new Map(); }
  subscribe(route, listener) {
    const list = this.listeners.get(route) || [];
    list.push(listener);
    this.listeners.set(route, list);
    return () => {};
  }
}

function registry(count = 3) {
  const agents = Array.from({ length: count }, (_, index) => ({
    agentId: `A${index + 1}`,
    role: "worker",
    tabId: index + 10,
    status: "IDLE",
    protocolContext: null,
    lastSeenAt: 0
  }));
  return {
    agents,
    listAgents() { return agents.map((agent) => ({ ...agent })); },
    getAgent(agentId) { const agent = agents.find((item) => item.agentId === agentId); return agent ? { ...agent } : null; },
    async setProtocolContext(agentId, context) {
      const agent = agents.find((item) => item.agentId === agentId);
      if (!agent) return null;
      agent.protocolContext = { ...context };
      return { ...agent };
    },
    async clearProtocolContext(agentId) {
      const agent = agents.find((item) => item.agentId === agentId);
      if (agent) agent.protocolContext = null;
      return agent ? { ...agent } : null;
    }
  };
}

function task(id, dependencies, allow, priority = 50) {
  return {
    id,
    title: id,
    objective: `Execute ${id}`,
    kind: "code",
    dependencies,
    scope: { allow },
    acceptanceCriteria: [`${id} accepted`],
    verification: ["npm test"],
    priority,
    risk: "low",
    estimatedComplexity: "S"
  };
}

function project(tasks) {
  return {
    projectId: "P1",
    status: "READY",
    initialGoal: "Execute a synthetic scheduler test safely.",
    repository: { url: "https://github.com/acme/widget" },
    taskGraph: { tasks }
  };
}

function projectStore(initial) {
  const state = { project: initial };
  return {
    state,
    getActiveProject() { return JSON.parse(JSON.stringify(state.project)); },
    async setExecutionStatus(projectId, status, details) {
      assert.equal(projectId, state.project.projectId);
      state.project.status = status;
      state.project.execution = { status, details };
      return this.getActiveProject();
    }
  };
}

function completion(run) {
  return {
    event: {
      v: 1,
      event: "DONE",
      projectId: "P1",
      taskId: run.taskId,
      runId: run.runId,
      agentId: run.agentId,
      eventId: `E-${run.runId}`,
      sequence: 1,
      payload: { summary: "done" }
    }
  };
}

test("runs three independent tasks in parallel and unlocks the dependent fourth only after all prerequisites", async () => {
  const graph = project([
    task("T1", [], ["src/a/**"], 30),
    task("T2", [], ["src/b/**"], 20),
    task("T3", [], ["src/c/**"], 10),
    task("T4", ["T1", "T2", "T3"], ["src/final/**"], 100)
  ]);
  const store = new SchedulerStore({ storageArea: fakeStorage() });
  const workers = registry(3);
  const projects = projectStore(graph);
  const prompts = [];
  let runId = 0;
  const engine = new SchedulerEngine({
    store,
    projectStore: projects,
    registry: workers,
    eventBus: new FakeEventBus(),
    idFactory: () => `R${++runId}`,
    sendPrompt: async (agentId, prompt) => { prompts.push({ agentId, prompt }); return { ok: true }; }
  });

  await engine.init();
  const started = await engine.start({ maxWorkers: 3 });
  assert.equal(started.ok, true);
  assert.equal(store.activeRuns().length, 3);
  assert.deepEqual(new Set(store.activeRuns().map((run) => run.taskId)), new Set(["T1", "T2", "T3"]));
  assert.equal(store.getTask("T4").status, "READY");
  assert.equal(prompts.length, 3);

  for (const taskId of ["T1", "T2"]) {
    const run = store.activeRuns().find((item) => item.taskId === taskId);
    await engine.handleCompletion(completion(run));
    assert.equal(store.getTask("T4").status, "READY");
    assert.equal(store.activeRuns().some((item) => item.taskId === "T4"), false);
  }

  const third = store.activeRuns().find((item) => item.taskId === "T3");
  await engine.handleCompletion(completion(third));
  const finalRun = store.activeRuns().find((item) => item.taskId === "T4");
  assert.ok(finalRun);
  assert.equal(prompts.length, 4);

  await engine.handleCompletion(completion(finalRun));
  assert.equal(store.summary().status, "COMPLETED_UNVERIFIED");
  assert.equal(projects.state.project.status, "COMPLETED_UNVERIFIED");
});

test("never assigns mutually exclusive overlapping tasks at the same time", async () => {
  const graph = project([
    task("T1", [], ["src/shared/**"], 100),
    task("T2", [], ["src/shared/nested/**"], 90)
  ]);
  const store = new SchedulerStore({ storageArea: fakeStorage() });
  const engine = new SchedulerEngine({
    store,
    projectStore: projectStore(graph),
    registry: registry(2),
    eventBus: new FakeEventBus(),
    idFactory: (() => { let id = 0; return () => `R${++id}`; })(),
    sendPrompt: async () => ({ ok: true })
  });
  await engine.init();
  await engine.start({ maxWorkers: 2 });
  assert.equal(store.activeRuns().length, 1);
  assert.equal(store.activeRuns()[0].taskId, "T1");
  assert.ok(store.recentDecisions(20).some((entry) => entry.type === "task_deferred_conflict" && entry.details.taskId === "T2"));
});

test("watchdog retries then escalates when retry budget is exhausted", async () => {
  let now = 100000;
  const graph = project([task("T1", [], ["src/a/**"])]);
  const store = new SchedulerStore({ storageArea: fakeStorage(), clock: () => now });
  const projects = projectStore(graph);
  const engine = new SchedulerEngine({
    store,
    projectStore: projects,
    registry: registry(1),
    eventBus: new FakeEventBus(),
    clock: () => now,
    idFactory: () => "R1",
    sendPrompt: async () => ({ ok: true })
  });
  await engine.init();
  await engine.start({ maxWorkers: 1, maxRetries: 0, runTimeoutMs: 60000 });
  assert.equal(store.activeRuns().length, 1);
  now += 61000;
  await engine.tick({ reason: "test_watchdog" });
  assert.equal(store.getTask("T1").status, "NEEDS_USER");
  assert.equal(store.summary().status, "NEEDS_USER");
  assert.equal(projects.state.project.status, "NEEDS_USER");
});

test("recent content heartbeat keeps a long-running Worker alive", async () => {
  let now = 100000;
  const graph = project([task("T1", [], ["src/a/**"])]);
  const store = new SchedulerStore({ storageArea: fakeStorage(), clock: () => now });
  const workers = registry(1);
  const engine = new SchedulerEngine({
    store,
    projectStore: projectStore(graph),
    registry: workers,
    eventBus: new FakeEventBus(),
    clock: () => now,
    idFactory: () => "R1",
    sendPrompt: async () => ({ ok: true })
  });
  await engine.init();
  await engine.start({ maxWorkers: 1, maxRetries: 0, runTimeoutMs: 60000 });
  now += 61000;
  workers.agents[0].lastSeenAt = now;
  workers.agents[0].status = "BUSY";
  await engine.tick({ reason: "heartbeat_watchdog" });
  assert.equal(store.activeRuns().length, 1);
  assert.notEqual(store.getTask("T1").status, "NEEDS_USER");
});

test("restart immediately retries an active run whose Worker disappeared", async () => {
  const storage = fakeStorage();
  const graph = project([task("T1", [], ["src/a/**"])]);
  const seed = new SchedulerStore({ storageArea: storage });
  await seed.load();
  await seed.initializeProject(graph, { maxRetries: 2 });
  await seed.createRun({ taskId: "T1", runId: "R-old", agentId: "A1" });

  const workers = registry(1);
  workers.agents[0].tabId = null;
  workers.agents[0].status = "OFFLINE";
  const engine = new SchedulerEngine({
    store: new SchedulerStore({ storageArea: storage }),
    projectStore: projectStore({ ...graph, status: "RUNNING" }),
    registry: workers,
    eventBus: new FakeEventBus(),
    sendPrompt: async () => ({ ok: true })
  });
  await engine.init();
  assert.equal(engine.store.getRun("R-old").status, "AGENT_UNAVAILABLE_AFTER_RESTART");
  assert.equal(engine.store.getTask("T1").status, "READY");
  assert.ok(engine.store.recentDecisions(20).some((entry) => entry.type === "recovered_agent_unavailable"));
});
