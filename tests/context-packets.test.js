const test = require("node:test");
const assert = require("node:assert/strict");

require("../prompts/planning-prompts.js");
require("../prompts/worker-prompts.js");
require("../prompts/review-prompts.js");
require("../prompts/integration-prompts.js");
const { ContextStore } = require("../background/context-store.js");
const { ContextPacketService, BUDGETS } = require("../context/context-packets.js");

function clone(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }

class StorageArea {
  constructor() { this.data = {}; }
  async get(keys) {
    const list = Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(list.filter((key) => this.data[key] !== undefined).map((key) => [key, clone(this.data[key])]));
  }
  async set(values) { Object.assign(this.data, clone(values)); }
}

function harness() {
  const huge = "x".repeat(25000);
  const project = {
    projectId: "P1",
    status: "RUNNING",
    stage: "EXECUTION",
    initialGoal: "Build a portable multi-agent orchestration core without transcript dependence.",
    repository: { url: "https://github.com/acme/demo", fullName: "acme/demo", tabId: 999 },
    stageHistory: [
      { stage: "DISCOVERY", runId: "PD1", status: "completed", at: 1 },
      { stage: "PLAN_V1", runId: "PP1", status: "completed", at: 2 }
    ],
    artifacts: {
      DISCOVERY: {
        stack: ["JavaScript", "Node"],
        entrypoints: ["src/index.js"],
        commands: { test: ["npm test"] },
        modules: Array.from({ length: 40 }, (_, i) => `src/module-${i}.js`),
        instructions: { agentsMd: "present", transcript: "must disappear" },
        sensitiveAreas: ["auth"],
        constraints: ["no direct main writes"],
        rawTranscript: huge
      },
      PLAN_V1: { completionDefinition: "all checks pass", transcript: huge },
      CRITIQUE: { findings: [] },
      PLAN_V2: { architectureRules: ["core owns state"], completionDefinition: "verified" },
      DECOMPOSE: { tasks: [] }
    }
  };
  const tasks = {
    T1: {
      id: "T1", title: "Foundation", objective: "Create base", status: "APPROVED", dependencies: [],
      acceptanceCriteria: ["base works"], verification: ["npm test"],
      lastArtifact: { branch: "orchestra/P1/T1/R1", commit: "a".repeat(40), baseSha: "b".repeat(40), targetBranch: "main", changedFiles: ["src/base.js"], tabId: 7 },
      lastReview: { status: "APPROVED", summary: "good", messages: ["old chat"] }
    },
    T2: {
      id: "T2", title: "Feature", objective: huge, status: "READY", dependencies: ["T1"],
      scope: { allow: ["src/module-2*"], deny: [] }, acceptanceCriteria: ["feature works", huge], verification: ["npm test"],
      transcript: huge, sessionId: "42"
    }
  };
  const schedulerStore = {
    listTasks: () => Object.values(tasks).map(clone),
    getTask: (id) => tasks[id] ? clone(tasks[id]) : null,
    getRun: () => null,
    activeRuns: () => [],
    recentDecisions: () => Array.from({ length: 140 }, (_, index) => ({ at: index + 10, type: `decision-${index}`, details: { taskId: "T2", rawResponse: huge } }))
  };
  const reviewStore = { active: () => [], list: () => [] };
  const integrationStore = { summary: () => ({ projectId: "P1", status: "IDLE" }) };
  const recoveryStore = { summary: () => ({ projectId: "P1", status: "RUNNING", issues: [] }) };
  const projectStore = { getActiveProject: () => clone(project) };
  const contextStore = new ContextStore({ storageArea: new StorageArea(), clock: () => 500 });
  const service = new ContextPacketService({ contextStore, projectStore, schedulerStore, reviewStore, integrationStore, recoveryStore, clock: () => 500 });
  return { service, contextStore, project, tasks, huge };
}

function serialized(value) { return JSON.stringify(value); }

function assertPortable(packet, budget) {
  const text = serialized(packet);
  assert.equal(packet.packetVersion, 1);
  assert.equal(packet.provenance.generatedFromPersistedState, true);
  assert.equal(packet.provenance.transcriptCopied, false);
  assert.equal(packet.budget.withinBudget, true);
  assert.ok(Buffer.byteLength(text, "utf8") <= budget, `${Buffer.byteLength(text, "utf8")} > ${budget}`);
  for (const forbidden of ["tabId", "sessionId", "rawTranscript", "rawResponse", "chatHistory", "conversationHistory"]) assert.equal(text.includes(`\"${forbidden}\"`), false, forbidden);
}

test("task packet is bounded, strips transcript/runtime state and carries dependency artifact refs", () => {
  const { service, project, tasks } = harness();
  const packet = service.buildTaskPacket({
    project,
    task: tasks.T2,
    runId: "R2",
    agentId: "A2",
    gitAssignment: { required: true, branch: "orchestra/P1/T2/R2", baseSha: "b".repeat(40), targetBranch: "main", startSha: "b".repeat(40) }
  });
  assertPortable(packet, BUDGETS.task);
  assert.equal(packet.logicalRole.logicalRoleId, "task:P1:T2");
  assert.equal(packet.dependencies[0].taskId, "T1");
  assert.equal(packet.artifactRefs[0].commit, "a".repeat(40));
  assert.ok(packet.repositoryContext.modules.length <= 18);
  assert.equal(packet.provenance.promptContractVersion, 4);
});

test("same logical Worker role can be bootstrapped onto a different agent session", () => {
  const { service, project, tasks } = harness();
  const first = service.buildTaskPacket({ project, task: tasks.T2, runId: "R2", agentId: "A-old" });
  const replacement = service.buildTaskPacket({ project, task: tasks.T2, runId: "R3", agentId: "A-new" });
  assert.equal(first.logicalRole.logicalRoleId, replacement.logicalRole.logicalRoleId);
  assert.equal(first.identity.agentId, "A-old");
  assert.equal(replacement.identity.agentId, "A-new");
  assert.equal(replacement.project.projectId, "P1");
  assert.equal(serialized(replacement).includes("old chat"), false);
});

test("Lead, Reviewer and Integrator packets share versioned bounded provenance", () => {
  const { service, project, tasks, huge } = harness();
  project.status = "PLANNING";
  project.stage = "PLAN_V2";
  project.currentRunId = "PL2";
  const lead = service.buildLeadPacket({ project, stage: "PLAN_V2", runId: "PL2", agentId: "L2" });
  assertPortable(lead, BUDGETS.lead);
  assert.equal(lead.logicalRole.logicalRoleId, "lead:P1:PLAN_V2");
  assert.equal(lead.provenance.promptContractVersion, 2);

  const review = service.buildReviewPacket({
    project,
    task: tasks.T2,
    review: { reviewId: "V2", iteration: 2, authorAgentId: "A1" },
    agentId: "A3",
    packet: { artifact: tasks.T1.lastArtifact, diff: { files: [{ filename: "src/base.js", patch: huge }] }, worker: { summary: huge } }
  });
  assertPortable(review, BUDGETS.review);
  assert.equal(review.logicalRole.logicalRoleId, "review:P1:T2:2");
  assert.equal(review.provenance.promptContractVersion, 2);

  const integration = service.buildIntegrationPacket({
    project,
    agentId: "A4",
    run: {
      runId: "I1", branch: "orchestra/P1/integration/I1", baseSha: "b".repeat(40), targetBranch: "main",
      taskOrder: ["T1"], mergeTaskIds: ["T1"], artifacts: [{ taskId: "T1", branch: tasks.T1.lastArtifact.branch, commit: tasks.T1.lastArtifact.commit, changedFiles: ["src/base.js"] }], verificationCommands: ["npm test"]
    }
  });
  assertPortable(integration, BUDGETS.integration);
  assert.equal(integration.logicalRole.logicalRoleId, "integration:P1");
  assert.equal(integration.provenance.promptContractVersion, 2);
});

test("lead summary compacts completed tasks and decisions register from persisted state", () => {
  const { service, project } = harness();
  const packet = service.buildLeadPacket({ project: { ...project, status: "PLANNING", stage: "CRITIQUE" }, stage: "CRITIQUE", runId: "PC1", agentId: "L1" });
  assert.equal(packet.completedTasks[0].taskId, "T1");
  assert.equal(packet.completedTasks[0].artifactRef.commit, "a".repeat(40));
  assert.ok(packet.decisions.length <= 30);
  assert.ok(service.contextStore.state.decisions.length <= 120);
  assert.ok(service.contextStore.state.leadSummary);
});
