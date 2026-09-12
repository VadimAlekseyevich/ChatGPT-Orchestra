const test = require("node:test");
const assert = require("node:assert/strict");

require("../background/conflict-policy.js");
require("../background/git-provider.js");
require("../prompts/worker-prompts.js");
const { SchedulerStore } = require("../background/scheduler-store.js");
const { SchedulerEngine } = require("../background/scheduler-engine.js");

const BASE_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const COMMIT_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

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

function fakeGitProvider({ validation = null } = {}) {
  return {
    branchName(projectId, taskId, runId) { return `orchestra/${projectId}/${taskId}/${runId}`; },
    async captureBase(project) {
      return {
        ok: true,
        snapshot: {
          provider: "test-git",
          repositoryFullName: project.repository.fullName,
          defaultBranch: "main",
          baseSha: BASE_SHA,
          capturedAt: 1,
          cleanupPolicy: "retain_until_review_or_manual_cleanup",
          lastCheckedAt: 1,
          currentTargetSha: BASE_SHA
        }
      };
    },
    async checkBaseFresh() { return { ok: true, currentTargetSha: BASE_SHA, checkedAt: Date.now() }; },
    async validateArtifact({ run }) {
      if (validation) return validation(run);
      return {
        ok: true,
        artifact: {
          provider: "test-git",
          branch: run.git.branch,
          commit: COMMIT_SHA,
          baseSha: BASE_SHA,
          targetBranch: "main",
          changedFiles: [`src/${run.taskId}.js`],
          verifiedAt: 2
        },
        freshness: { ok: true, currentTargetSha: BASE_SHA, checkedAt: 2 }
      };
    }
  };
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
    repository: { url: "https://github.com/acme/widget", owner: "acme", repo: "widget", fullName: "acme/widget" },
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

function engineOptions({ store, projects, workers, idFactory, sendPrompt, clock, gitProvider } = {}) {
  return {
    store,
    projectStore: projects,
    registry: workers,
    eventBus: new FakeEventBus(),
    gitProvider: gitProvider || fakeGitProvider(),
    ...(clock ? { clock } : {}),
    ...(idFactory ? { idFactory } : {}),
    sendPrompt: sendPrompt || (async () => ({ ok: true }))
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
  const engine = new SchedulerEngine(engineOptions({
    store,
    projects,
    workers,
    idFactory: () => `R${++runId}`,
    sendPrompt: async (agentId, prompt) => { prompts.push({ agentId, prompt }); return { ok: true }; }
  }));

  await engine.init();
  const started = await engine.start({ maxWorkers: 3 });
  assert.equal(started.ok, true);
  assert.equal(store.activeRuns().length, 3);
  assert.deepEqual(new Set(store.activeRuns().map((run) => run.taskId)), new Set(["T1", "T2", "T3"]));
  assert.equal(store.getTask("T4").status, "READY");
  assert.equal(prompts.length, 3);
  assert.ok(prompts.every(({ prompt }) => prompt.includes("GIT ISOLATION CONTRACT")));

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
  assert.equal(store.getTask("T4").lastArtifact.commit, COMMIT_SHA);
});

test("never assigns mutually exclusive overlapping tasks at the same time", async () => {
  const graph = project([
    task("T1", [], ["src/shared/**"], 100),
    task("T2", [], ["src/shared/nested/**"], 90)
  ]);
  const store = new SchedulerStore({ storageArea: fakeStorage() });
  const engine = new SchedulerEngine(engineOptions({ store, projects: projectStore(graph), workers: registry(2), idFactory: (() => { let id = 0; return () => `R${++id}`; })() }));
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
  const engine = new SchedulerEngine(engineOptions({ store, projects, workers: registry(1), clock: () => now, idFactory: () => "R1" }));
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
  const engine = new SchedulerEngine(engineOptions({ store, projects: projectStore(graph), workers, clock: () => now, idFactory: () => "R1" }));
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
  await seed.setGitSnapshot((await fakeGitProvider().captureBase(graph)).snapshot);
  await seed.createRun({
    taskId: "T1",
    runId: "R-old",
    agentId: "A1",
    git: { required: true, provider: "test-git", branch: "orchestra/P1/T1/R-old", targetBranch: "main", baseSha: BASE_SHA }
  });

  const workers = registry(1);
  workers.agents[0].tabId = null;
  workers.agents[0].status = "OFFLINE";
  const engine = new SchedulerEngine(engineOptions({
    store: new SchedulerStore({ storageArea: storage }),
    projects: projectStore({ ...graph, status: "RUNNING" }),
    workers
  }));
  await engine.init();
  assert.equal(engine.store.getRun("R-old").status, "AGENT_UNAVAILABLE_AFTER_RESTART");
  assert.equal(engine.store.getTask("T1").status, "READY");
  assert.ok(engine.store.recentDecisions(20).some((entry) => entry.type === "recovered_agent_unavailable"));
});

test("invalid Git artifact cannot unlock dependencies and is retried", async () => {
  const graph = project([task("T1", [], ["src/a/**"]), task("T2", ["T1"], ["src/b/**"])]);
  const store = new SchedulerStore({ storageArea: fakeStorage() });
  const workers = registry(1);
  const projects = projectStore(graph);
  const engine = new SchedulerEngine(engineOptions({
    store,
    projects,
    workers,
    idFactory: (() => { let id = 0; return () => `R${++id}`; })(),
    gitProvider: fakeGitProvider({ validation: () => ({ ok: false, reason: "git_branch_head_mismatch" }) })
  }));
  await engine.init();
  await engine.start({ maxWorkers: 1, maxRetries: 1 });
  const first = store.activeRuns()[0];
  await engine.handleCompletion(completion(first));
  assert.notEqual(store.getTask("T1").status, "DONE_UNVERIFIED");
  assert.equal(store.getTask("T2").status, "READY");
  assert.ok(store.recentDecisions(20).some((entry) => entry.type === "git_artifact_invalid"));
});
