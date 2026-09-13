const test = require("node:test");
const assert = require("node:assert/strict");

require("../background/git-provider.js");
require("../prompts/review-prompts.js");
const { SchedulerStore } = require("../background/scheduler-store.js");
const { ReviewStore } = require("../background/review-store.js");
const { ReviewEngine, validateReviewPayload } = require("../background/review-engine.js");

const BASE = "a".repeat(40);
const COMMIT = "b".repeat(40);

function fakeStorage() {
  const data = {};
  return { data, async get(key) { return { [key]: data[key] }; }, async set(values) { Object.assign(data, values); } };
}

class FakeEventBus {
  constructor() { this.listeners = new Map(); }
  subscribe(route, listener) { const list = this.listeners.get(route) || []; list.push(listener); this.listeners.set(route, list); return () => {}; }
}

function registry(count = 2) {
  const agents = Array.from({ length: count }, (_, index) => ({ agentId: `A${index + 1}`, role: "worker", tabId: index + 10, status: "IDLE", lastSeenAt: 1, protocolContext: null }));
  return {
    agents,
    listAgents() { return agents.map((agent) => ({ ...agent })); },
    getAgent(id) { const agent = agents.find((item) => item.agentId === id); return agent ? { ...agent } : null; },
    async setProtocolContext(id, context) { const agent = agents.find((item) => item.agentId === id); if (!agent) return null; agent.protocolContext = context ? { ...context } : null; return { ...agent }; },
    async clearProtocolContext(id) { const agent = agents.find((item) => item.agentId === id); if (agent) agent.protocolContext = null; return agent ? { ...agent } : null; }
  };
}

function project() {
  return {
    projectId: "P1",
    status: "RUNNING",
    initialGoal: "Review a bounded implementation.",
    repository: { url: "https://github.com/acme/widget", owner: "acme", repo: "widget", fullName: "acme/widget" },
    artifacts: { DISCOVERY: { architectureRules: ["Keep public API compatible"] } },
    taskGraph: { tasks: [{ id: "T1", title: "Task", objective: "Implement behavior", kind: "code", dependencies: [], scope: { allow: ["src/**"] }, acceptanceCriteria: ["returns 200", "rejects invalid input"], verification: ["npm test"], risk: "medium", estimatedComplexity: "S" }] }
  };
}

function projectStore(initial) {
  const state = { project: initial };
  return {
    state,
    getActiveProject() { return JSON.parse(JSON.stringify(state.project)); },
    async setExecutionStatus(projectId, status, details) { assert.equal(projectId, state.project.projectId); state.project.status = status; state.project.execution = { status, details }; return this.getActiveProject(); }
  };
}

function gitProvider() {
  return {
    async compare() {
      return { ok: true, comparison: { status: "ahead", ahead_by: 1, behind_by: 0, total_commits: 1, files: [{ filename: "src/x.js", status: "modified", additions: 3, deletions: 1, changes: 4, patch: "@@ -1 +1 @@\n-old\n+new" }] } };
    }
  };
}

async function seedScheduler({ reviewIterations = 0 } = {}) {
  const store = new SchedulerStore({ storageArea: fakeStorage() });
  await store.load();
  await store.initializeProject(project(), { maxWorkers: 2 });
  await store.setGitSnapshot({ provider: "test", defaultBranch: "main", baseSha: BASE });
  await store.createRun({ taskId: "T1", runId: "R1", agentId: "A1", git: { required: true, provider: "test", branch: "orchestra/P1/T1/R1", targetBranch: "main", baseSha: BASE } });
  await store.recordArtifactValidation("R1", { ok: true, artifact: { provider: "test", branch: "orchestra/P1/T1/R1", commit: COMMIT, baseSha: BASE, targetBranch: "main", changedFiles: ["src/x.js"] } });
  await store.markDone("R1", { summary: "implemented", testsPerformed: ["npm test"], knownLimitations: [] });
  store.state.tasks.T1.reviewIterations = reviewIterations;
  await store.persist();
  return store;
}

function approvedPayload() {
  return {
    summary: "all criteria satisfied",
    criteria: [
      { criterion: "returns 200", status: "PASS", evidence: "diff and test evidence" },
      { criterion: "rejects invalid input", status: "PASS", evidence: "negative test evidence" }
    ],
    scopeCheck: { status: "PASS", evidence: "only src/x.js changed and Phase 6 scope validation passed" },
    testsAssessment: { status: "PASS", evidence: "npm test reported by worker and changes align" },
    issues: [],
    requiredChanges: []
  };
}

function changesPayload() {
  return {
    summary: "invalid input criterion is not satisfied",
    criteria: [
      { criterion: "returns 200", status: "PASS", evidence: "covered" },
      { criterion: "rejects invalid input", status: "FAIL", evidence: "no validation branch in diff" }
    ],
    scopeCheck: { status: "PASS", evidence: "scope is valid" },
    testsAssessment: { status: "FAIL", evidence: "negative path test is missing" },
    issues: [{ severity: "high", code: "AC_MISSING", message: "Invalid input is accepted", evidence: "reviewed diff" }],
    requiredChanges: ["Reject invalid input and add a negative-path test"]
  };
}

async function setup({ workerCount = 2, reviewIterations = 0, maxReviewIterations = 3 } = {}) {
  const schedulerStore = await seedScheduler({ reviewIterations });
  const reviewStore = new ReviewStore({ storageArea: fakeStorage(), idFactory: () => `REV-${reviewIterations + 1}` });
  const projects = projectStore(project());
  const workers = registry(workerCount);
  const prompts = [];
  const engine = new ReviewEngine({
    store: reviewStore,
    schedulerStore,
    projectStore: projects,
    registry: workers,
    eventBus: new FakeEventBus(),
    gitProvider: gitProvider(),
    sendPrompt: async (agentId, prompt) => { prompts.push({ agentId, prompt }); return { ok: true }; },
    onSchedulerTick: async () => ({ ok: true })
  });
  await engine.init();
  await engine.configureProject("P1", { maxReviewIterations });
  const task = schedulerStore.getTask("T1");
  const run = schedulerStore.getRun("R1");
  await engine.enqueueForWorkerCompletion({ task, run, workerReport: task.workerReport });
  return { engine, schedulerStore, reviewStore, projects, workers, prompts };
}

test("self-review is impossible and a distinct idle agent receives the review", async () => {
  const { schedulerStore, reviewStore, prompts } = await setup({ workerCount: 2 });
  const review = reviewStore.list()[0];
  assert.equal(review.authorAgentId, "A1");
  assert.equal(review.reviewerAgentId, "A2");
  assert.equal(schedulerStore.getTask("T1").status, "REVIEWING");
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].agentId, "A2");
  assert.match(prompts[0].prompt, /independent ChatGPT Orchestra Reviewer/);
  assert.doesNotMatch(prompts[0].prompt, /full worker chat history/i);
});

test("with only the author available review remains pending instead of self-approving", async () => {
  const { schedulerStore, reviewStore, prompts } = await setup({ workerCount: 1 });
  assert.equal(reviewStore.list()[0].status, "PENDING");
  assert.equal(reviewStore.list()[0].reviewerAgentId, null);
  assert.equal(schedulerStore.getTask("T1").status, "REVIEW_PENDING");
  assert.equal(prompts.length, 0);
});

test("structured REVIEW_APPROVED moves task to APPROVED", async () => {
  const { engine, schedulerStore, reviewStore } = await setup();
  const review = reviewStore.list()[0];
  await engine.handleReviewEvent({ event: { event: "REVIEW_APPROVED", projectId: "P1", taskId: "T1", runId: review.reviewId, agentId: "A2", payload: approvedPayload() } });
  assert.equal(schedulerStore.getTask("T1").status, "APPROVED");
  assert.equal(schedulerStore.isComplete(), true);
  assert.equal(reviewStore.get(review.reviewId).status, "APPROVED");
});

test("violated acceptance criterion returns task to rework and cannot complete review phase", async () => {
  const { engine, schedulerStore, reviewStore } = await setup();
  const review = reviewStore.list()[0];
  await engine.handleReviewEvent({ event: { event: "CHANGES_REQUIRED", projectId: "P1", taskId: "T1", runId: review.reviewId, agentId: "A2", payload: changesPayload() } });
  const task = schedulerStore.getTask("T1");
  assert.equal(task.status, "READY");
  assert.equal(schedulerStore.isComplete(), false);
  assert.equal(task.reworkContext.previousCommit, COMMIT);
  assert.deepEqual(task.reworkContext.requiredChanges, ["Reject invalid input and add a negative-path test"]);
});

test("max review iterations escalates instead of cycling forever", async () => {
  const { engine, schedulerStore, reviewStore, projects } = await setup({ reviewIterations: 2, maxReviewIterations: 3 });
  const review = reviewStore.list()[0];
  assert.equal(review.iteration, 3);
  await engine.handleReviewEvent({ event: { event: "CHANGES_REQUIRED", projectId: "P1", taskId: "T1", runId: review.reviewId, agentId: "A2", payload: changesPayload() } });
  assert.equal(schedulerStore.getTask("T1").status, "NEEDS_USER");
  assert.equal(schedulerStore.summary().status, "NEEDS_USER");
  assert.equal(projects.state.project.status, "NEEDS_USER");
});

test("incomplete approval payload fails closed", () => {
  const task = project().taskGraph.tasks[0];
  const result = validateReviewPayload("REVIEW_APPROVED", {
    summary: "looks good",
    criteria: [{ criterion: "returns 200", status: "PASS", evidence: "some evidence" }],
    scopeCheck: { status: "PASS", evidence: "ok" },
    testsAssessment: { status: "PASS", evidence: "ok" }
  }, task);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "review_criteria_incomplete");
});
