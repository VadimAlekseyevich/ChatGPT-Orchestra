const test = require("node:test");
const assert = require("node:assert/strict");

const ContextPackets = require("../context/context-packets.js");
const PlanningPrompts = require("../prompts/planning-prompts.js");
const WorkerPrompts = require("../prompts/worker-prompts.js");
const ReviewPrompts = require("../prompts/review-prompts.js");
const IntegrationPrompts = require("../prompts/integration-prompts.js");

function basePacket(type, overrides = {}) {
  return {
    packetVersion: 1,
    packetType: type,
    identity: { projectId: "P1", taskId: "T1", runId: "R1", agentId: "A1" },
    logicalRole: { role: type, logicalRoleId: `${type}:P1` },
    project: { projectId: "P1", repository: { url: "https://github.com/acme/demo" } },
    provenance: { promptContractVersion: 1, generatedFromPersistedState: true, transcriptCopied: false },
    budget: { withinBudget: true },
    ...overrides
  };
}

const project = {
  projectId: "P1",
  repository: { url: "https://github.com/acme/demo" },
  initialGoal: "Build portable agent context packets.",
  status: "PLANNING",
  stage: "PLAN_V1"
};

const task = {
  id: "T1",
  title: "Implement context packets",
  objective: "Make role bootstrap independent from chat history.",
  dependencies: [],
  scope: { allow: ["context/**"] },
  acceptanceCriteria: ["fresh sessions can continue"],
  verification: ["npm run test:phase13"]
};

function assertFailClosed(prompt, sentinel) {
  assert.match(prompt, /context_packet_incomplete/);
  assert.match(prompt, /NEEDS_USER/);
  assert.doesNotMatch(prompt, /DONE is allowed only/);
  if (sentinel) assert.equal(prompt.includes(sentinel), false);
}

test("Worker prompt rejects structural truncation and removes incomplete task payload", () => {
  const sentinel = "DO_NOT_LEAK_TRUNCATED_TASK";
  const packet = basePacket("task", {
    task: { title: sentinel, dependencies: [{ _truncatedItems: 7 }] },
    dependencies: [],
    assignment: { git: null },
    artifactRefs: []
  });
  const gate = WorkerPrompts.packetCompleteness(packet);
  assert.equal(gate.ok, false);
  assert.deepEqual(gate.incompleteSections, ["task"]);
  const prompt = WorkerPrompts.buildWorkerPrompt({ project, task, runId: "R1", agentId: "A1", packet });
  assertFailClosed(prompt, sentinel);
});

test("Worker prompt rejects actual serialized oversize even if packet metadata claims it fits", () => {
  const packet = basePacket("task", {
    task,
    dependencies: [],
    assignment: { git: null },
    artifactRefs: [],
    padding: "x".repeat(ContextPackets.BUDGETS.task + 2048)
  });
  const gate = WorkerPrompts.packetCompleteness(packet);
  assert.equal(gate.ok, false);
  assert.ok(gate.actualBytes > gate.maxBytes);
});

test("Lead prompt fails closed when required stageInputs were structurally truncated", () => {
  const sentinel = "DO_NOT_LEAK_PLANNING_ARTIFACT";
  const packet = basePacket("lead", {
    stage: "PLAN_V1",
    stageInputs: { DISCOVERY: { summary: sentinel, modules: [{ _truncatedItems: 3 }] } },
    artifactRefs: []
  });
  const prompt = PlanningPrompts.buildPlanningPrompt({ stage: "PLAN_V1", project, agentId: "L1", runId: "PL1", packet, replacement: true });
  assertFailClosed(prompt, sentinel);
  assert.doesNotMatch(prompt, /@@ORCH_ARTIFACT_BEGIN/);
});

test("Reviewer prompt fails closed before approval when evidence is structurally incomplete", () => {
  const sentinel = "DO_NOT_LEAK_REVIEW_PATCH";
  const packet = basePacket("review", {
    task,
    review: { reviewId: "V1", iteration: 1, authorAgentId: "A0" },
    evidence: { diff: { files: [{ patch: sentinel }, { _truncatedItems: 9 }] } },
    artifactRefs: []
  });
  ContextPackets.setDefaultService({ buildReviewPacket: () => packet });
  try {
    const prompt = ReviewPrompts.buildReviewPrompt({
      project,
      task,
      review: { reviewId: "V1", iteration: 1, authorAgentId: "A0" },
      packet: {},
      agentId: "A1"
    });
    assertFailClosed(prompt, sentinel);
    assert.match(prompt, /REVIEW_APPROVED and CHANGES_REQUIRED are not valid/);
  } finally {
    ContextPackets.setDefaultService(null);
  }
});

test("Integrator and repair prompts fail closed on partial manifests", () => {
  const sentinel = "DO_NOT_LEAK_PARTIAL_ARTIFACT";
  const run = {
    projectId: "P1",
    runId: "I1",
    branch: "orchestra/P1/integration/I1",
    baseSha: "b".repeat(40),
    targetBranch: "main",
    taskOrder: ["T1"],
    mergeTaskIds: ["T1"],
    artifacts: [],
    verificationCommands: ["npm test"]
  };
  const integrationPacket = basePacket("integration", {
    integration: { ...run, artifacts: [{ taskId: "T1", branch: sentinel }, { _truncatedItems: 4 }] },
    approvedTasks: [],
    artifactRefs: []
  });
  const integrationPrompt = IntegrationPrompts.buildIntegratorPrompt({ project, run, agentId: "A2", packet: integrationPacket });
  assertFailClosed(integrationPrompt, sentinel);
  assert.doesNotMatch(integrationPrompt, /git merge --no-ff/);

  const repairTask = { repairTaskId: "IR1", attempt: 1, nextSequence: 2, conflict: { files: ["src/a.js"] } };
  const repairPacket = basePacket("repair", {
    integration: run,
    approvedTasks: [],
    artifactRefs: [],
    repair: { ...repairTask, conflict: { files: [{ _truncatedItems: 2 }], note: sentinel } }
  });
  const repairPrompt = IntegrationPrompts.buildRepairPrompt({ project, run, repairTask, agentId: "A2", packet: repairPacket });
  assertFailClosed(repairPrompt, sentinel);
  assert.doesNotMatch(repairPrompt, /re-run the conflicting merge/);
});
