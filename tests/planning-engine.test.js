const test = require("node:test");
const assert = require("node:assert/strict");

require("../prompts/planning-prompts.js");
require("../background/dag-validator.js");
const { ProjectStore } = require("../background/project-store.js");
const { PlanningEngine } = require("../background/planning-engine.js");

function fakeStorage() {
  const data = {};
  return {
    data,
    async get(key) { return { [key]: data[key] }; },
    async set(values) { Object.assign(data, values); }
  };
}

class FakeEventBus {
  constructor(recentEvents = []) {
    this.listeners = new Map();
    this.recentEvents = recentEvents;
  }
  subscribe(route, listener) {
    const list = this.listeners.get(route) || [];
    list.push(listener);
    this.listeners.set(route, list);
    return () => {};
  }
  recent() { return { events: this.recentEvents, rejections: [] }; }
}

function fakeRegistry() {
  const lead = { agentId: "A1", role: "lead", tabId: 7, status: "IDLE" };
  return {
    lead,
    contexts: [],
    listAgents() { return [lead]; },
    isAgentConnected(agent) { return Boolean(agent && agent.status !== "OFFLINE"); },
    async setProtocolContext(agentId, context) {
      assert.equal(agentId, "A1");
      lead.protocolContext = { ...context };
      this.contexts.push({ ...context });
      return { ...lead };
    }
  };
}

function discoveryArtifact(overrides = {}) {
  return {
    repositoryAccess: { status: "ok", inspectedPaths: ["package.json", "src/index.js"], gaps: [] },
    stack: ["JavaScript"],
    entrypoints: ["src/index.js"],
    commands: { build: [], test: ["npm test"], lint: [], typecheck: [] },
    modules: ["src"],
    persistence: [],
    ci: [],
    instructions: { agentsMd: "absent", paths: [] },
    sensitiveAreas: [],
    constraints: [],
    ...overrides
  };
}

function validGraph() {
  return {
    objectiveCoveredBy: ["T2"],
    tasks: [
      {
        id: "T1",
        title: "Implement core",
        objective: "Implement the core change.",
        kind: "code",
        dependencies: [],
        scope: { allow: ["src/**"] },
        acceptanceCriteria: ["core behavior works"],
        verification: ["npm test"],
        priority: 80,
        risk: "low",
        estimatedComplexity: "M"
      },
      {
        id: "T2",
        title: "Verify integration",
        objective: "Verify the integrated result.",
        kind: "code",
        dependencies: ["T1"],
        scope: { allow: ["tests/**"] },
        acceptanceCriteria: ["integration tests pass"],
        verification: ["npm test"],
        priority: 70,
        risk: "low",
        estimatedComplexity: "S"
      }
    ]
  };
}

function completion(project, stage, artifact) {
  return {
    event: {
      agentId: "A1",
      projectId: project.projectId,
      event: "DONE",
      payload: { stage }
    },
    source: { planningArtifact: artifact }
  };
}

test("runs the six planning stages and reaches READY with a validated DAG", async () => {
  const store = new ProjectStore({ storageArea: fakeStorage(), idFactory: () => "P1" });
  const registry = fakeRegistry();
  const bus = new FakeEventBus();
  const prompts = [];
  let run = 0;
  const engine = new PlanningEngine({
    projectStore: store,
    registry,
    eventBus: bus,
    idFactory: () => `R${++run}`,
    sendPrompt: async (agentId, prompt) => { prompts.push({ agentId, prompt }); return { ok: true }; }
  });
  await engine.init();
  const started = await engine.startProject({
    goal: "Implement a reliable multi-stage project planning pipeline.",
    repositoryUrl: "https://github.com/acme/widget"
  });
  assert.equal(started.ok, true);
  assert.equal(store.getActiveProject().stage, "DISCOVERY");
  assert.match(prompts[0].prompt, /@@ORCH_ARTIFACT_BEGIN/);
  assert.match(prompts[0].prompt, /repositoryAccess/);

  const artifacts = {
    DISCOVERY: discoveryArtifact(),
    PLAN_V1: { milestones: [{ id: "M1", objective: "core", dependencies: [] }], risks: [], verificationStrategy: ["npm test"], completionDefinition: "All planned behavior is implemented and verified." },
    CRITIQUE: { findings: [{ severity: "medium", issue: "add explicit acceptance criteria", correction: "make them task-level" }], blockingIssues: [] },
    PLAN_V2: { milestones: [{ id: "M1", objective: "core", dependencies: [] }], risks: [], verificationStrategy: ["npm test"], completionDefinition: "All planned behavior is implemented and verified.", agentsMdProposal: { action: "no_change" } },
    DECOMPOSE: validGraph(),
    DAG_CRITIC: validGraph()
  };

  for (const stage of ["DISCOVERY", "PLAN_V1", "CRITIQUE", "PLAN_V2", "DECOMPOSE", "DAG_CRITIC"]) {
    const project = store.getActiveProject();
    assert.equal(project.stage, stage);
    await engine.handleCompletion(completion(project, stage, artifacts[stage]));
  }

  const ready = store.getActiveProject();
  assert.equal(ready.status, "READY");
  assert.equal(ready.stage, "READY");
  assert.equal(ready.taskGraph.tasks.length, 2);
  assert.equal(ready.validation.ok, true);
  assert.equal(prompts.length, 6);
  assert.equal(registry.lead.protocolContext.taskId, "planning:complete");
});

test("fails closed when repository discovery says the repository is unavailable", async () => {
  const store = new ProjectStore({ storageArea: fakeStorage(), idFactory: () => "P1" });
  const registry = fakeRegistry();
  const prompts = [];
  const engine = new PlanningEngine({
    projectStore: store,
    registry,
    eventBus: new FakeEventBus(),
    idFactory: () => "R1",
    sendPrompt: async (_agentId, prompt) => { prompts.push(prompt); return { ok: true }; }
  });
  await engine.init();
  await engine.startProject({
    goal: "Plan changes only after proving repository access is available.",
    repositoryUrl: "https://github.com/acme/widget"
  });
  const project = store.getActiveProject();
  await engine.handleCompletion(completion(project, "DISCOVERY", discoveryArtifact({
    repositoryAccess: { status: "unavailable", inspectedPaths: [], gaps: ["repository unavailable"] }
  })));
  assert.equal(store.getActiveProject().status, "NEEDS_USER");
  assert.equal(store.getActiveProject().lastError.reason, "repository_access_unavailable");
  assert.equal(prompts.length, 1);
});

test("recovers an already accepted stage artifact after service-worker restart", async () => {
  const storage = fakeStorage();
  const seed = new ProjectStore({ storageArea: storage, idFactory: () => "P1" });
  await seed.load();
  await seed.createProject({
    goal: "Recover planning state without replaying an already accepted prompt.",
    repositoryUrl: "https://github.com/acme/widget"
  });
  await seed.beginStage("P1", { stage: "DISCOVERY", runId: "planning-discovery-existing" });

  const accepted = {
    event: {
      projectId: "P1",
      taskId: "planning:discovery",
      runId: "planning-discovery-existing",
      agentId: "A1",
      event: "DONE",
      payload: { stage: "DISCOVERY" }
    },
    source: { planningArtifact: discoveryArtifact() }
  };
  const registry = fakeRegistry();
  const prompts = [];
  const bus = new FakeEventBus([accepted]);
  const engine = new PlanningEngine({
    projectStore: new ProjectStore({ storageArea: storage, idFactory: () => "unused" }),
    registry,
    eventBus: bus,
    idFactory: () => "NEXT",
    sendPrompt: async (_agentId, prompt) => { prompts.push(prompt); return { ok: true }; }
  });
  await engine.init();
  await engine.init();

  assert.equal(engine.projectStore.getActiveProject().stage, "PLAN_V1");
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /planning stage PLAN_V1/);
  assert.equal(bus.listeners.get("completion").length, 1);
});

test("rejected planning artifact stays retryable and restarts the same stage with a fresh run", async () => {
  const store = new ProjectStore({ storageArea: fakeStorage(), idFactory: () => "P-artifact-retry" });
  const registry = fakeRegistry();
  const prompts = [];
  let run = 0;
  const engine = new PlanningEngine({
    projectStore: store,
    registry,
    eventBus: new FakeEventBus(),
    idFactory: () => `R${++run}`,
    sendPrompt: async (agentId, prompt) => {
      prompts.push({ agentId, prompt });
      return { ok: true, accepted: true };
    },
    logger: { info() {}, warn() {} }
  });
  await engine.init();

  const started = await engine.startProject({
    goal: "Plan a small feature and recover if the Lead returns a malformed stage artifact.",
    repositoryUrl: "https://github.com/acme/widget"
  });
  assert.equal(started.ok, true);

  let project = store.getActiveProject();
  await engine.handleCompletion(completion(project, "DISCOVERY", discoveryArtifact()));
  project = store.getActiveProject();
  assert.equal(project.stage, "PLAN_V1");
  const rejectedRunId = project.currentRunId;

  await engine.handleCompletion(completion(project, "PLAN_V1", {
    milestones: [],
    risks: [],
    verificationStrategy: ["npm test"],
    completionDefinition: ""
  }));

  project = store.getActiveProject();
  assert.equal(project.status, "PLANNING");
  assert.equal(project.stage, "PLAN_V1");
  assert.equal(project.currentRunId, rejectedRunId);
  assert.equal(project.lastError.reason, "plan_milestones_missing");
  assert.equal(project.lastError.details.retryable, true);
  assert.equal(project.lastError.details.retryMode, "fresh_run");
  assert.equal(engine.canRetryCurrentStage(), true);

  const retried = await engine.resumeCurrentStage({ reason: "manual_retry" });
  project = store.getActiveProject();
  assert.equal(retried.ok, true);
  assert.equal(retried.resumed, true);
  assert.equal(retried.freshRun, true);
  assert.equal(retried.previousRunId, rejectedRunId);
  assert.notEqual(project.currentRunId, rejectedRunId);
  assert.equal(project.stage, "PLAN_V1");
  assert.equal(project.lastError, undefined);
  assert.equal(prompts.length, 3);
  assert.match(prompts.at(-1).prompt, /planning stage PLAN_V1/);
});

test("Start Project refuses stale IDLE Lead when a fresh readiness check reports no composer", async () => {
  const store = new ProjectStore({ storageArea: fakeStorage(), idFactory: () => "P-stale" });
  const lead = { agentId: "A-stale", role: "lead", tabId: 9, status: "IDLE", chatState: null };
  const registry = {
    listAgents() { return [{ ...lead, chatState: lead.chatState ? { ...lead.chatState } : null }]; },
    isAgentConnected(agent) { return Boolean(agent && agent.status !== "OFFLINE"); },
    async pingAgent(agentId) {
      assert.equal(agentId, "A-stale");
      lead.status = "ERROR";
      lead.chatState = { availability: "unavailable", generating: false, composerOccupied: null };
      lead.lastError = "unavailable";
      return {
        ok: true,
        availability: "unavailable",
        generating: false,
        composerOccupied: null,
        agent: { ...lead, chatState: { ...lead.chatState } }
      };
    },
    async setProtocolContext() { throw new Error("must_not_bind_context"); }
  };
  const prompts = [];
  const engine = new PlanningEngine({
    projectStore: store,
    registry,
    eventBus: new FakeEventBus(),
    idFactory: () => "R-stale",
    sendPrompt: async (...args) => { prompts.push(args); return { ok: true }; }
  });
  await engine.init();

  const result = await engine.startProject({
    goal: "Do not create a project until the Lead composer is freshly available.",
    repositoryUrl: "https://github.com/acme/widget"
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "lead_not_ready");
  assert.equal(result.status, "ERROR");
  assert.equal(result.availability, "unavailable");
  assert.equal(store.getActiveProject(), null);
  assert.equal(prompts.length, 0);
});

test("planning retry preserves the persisted failed run until Lead readiness returns", async () => {
  const store = new ProjectStore({ storageArea: fakeStorage(), idFactory: () => "P-retry-ready" });
  await store.load();
  await store.createProject({
    goal: "Keep the current planning run intact while the Lead composer is unavailable.",
    repositoryUrl: "https://github.com/acme/widget"
  });
  await store.beginStage("P-retry-ready", { stage: "DISCOVERY", runId: "planning-discovery-existing" });
  await store.fail("P-retry-ready", "lead_prompt_failed", { reason: "composer_unavailable" }, "PLANNING");

  const lead = { agentId: "A-retry", role: "lead", tabId: 10, status: "IDLE" };
  const registry = {
    listAgents() { return [{ ...lead }]; },
    isAgentConnected(agent) { return Boolean(agent && agent.status !== "OFFLINE"); },
    async pingAgent() {
      return {
        ok: true,
        availability: "unavailable",
        generating: false,
        agent: { ...lead, status: "ERROR", chatState: { availability: "unavailable", generating: false } }
      };
    },
    async setProtocolContext() { throw new Error("must_not_rebind_while_unready"); },
    async clearProtocolContext() {}
  };
  const engine = new PlanningEngine({
    projectStore: store,
    registry,
    eventBus: new FakeEventBus(),
    sendPrompt: async () => { throw new Error("must_not_send_while_unready"); }
  });

  const result = await engine.resumeCurrentStage({ reason: "manual_retry" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "lead_not_ready");
  assert.equal(result.retryable, true);

  const persisted = store.getActiveProject();
  assert.equal(persisted.status, "PLANNING");
  assert.equal(persisted.stage, "DISCOVERY");
  assert.equal(persisted.currentRunId, "planning-discovery-existing");
  assert.equal(persisted.lastError.reason, "lead_prompt_failed");
  assert.equal(persisted.lastError.details.reason, "composer_unavailable");
});
