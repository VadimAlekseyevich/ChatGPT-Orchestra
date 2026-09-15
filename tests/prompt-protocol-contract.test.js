const test = require("node:test");
const assert = require("node:assert/strict");

const Protocol = require("../protocol/orchestra-protocol.js");
const ContextPackets = require("../context/context-packets.js");
const PlanningPrompts = require("../prompts/planning-prompts.js");
const WorkerPrompts = require("../prompts/worker-prompts.js");
const ReviewPrompts = require("../prompts/review-prompts.js");
const IntegrationPrompts = require("../prompts/integration-prompts.js");

const project = {
  projectId: "P1",
  repository: { url: "https://github.com/acme/demo", owner: "acme", repo: "demo", fullName: "acme/demo" },
  initialGoal: "Build a demo.",
  status: "PLANNING",
  stage: "DISCOVERY",
  artifacts: {}
};

const legacyPacket = { packetVersion: 0 };

function assertCanonicalIdentity(prompt, label) {
  assert.match(prompt, /"v"\s*:\s*1/, `${label} prompt must expose canonical v=1 identity`);
}

function parseExampleFromLine(prompt, marker) {
  const line = prompt.split("\n").find((candidate) => candidate.includes(marker));
  assert.ok(line, `missing example line: ${marker}`);
  const offset = line.indexOf("@@ORCH ");
  assert.notEqual(offset, -1, `missing @@ORCH envelope: ${marker}`);
  return Protocol.parseLine(line.slice(offset));
}

test("planning prompt names the version field exactly and includes a parseable turn-specific final envelope", () => {
  const prompt = PlanningPrompts.buildPlanningPrompt({
    stage: "DISCOVERY",
    project,
    agentId: "A1",
    runId: "planning-discovery-R1",
    packet: legacyPacket
  });
  assertCanonicalIdentity(prompt, "planning");
  assert.match(prompt, /version field is named exactly `v`/);
  assert.match(prompt, /Do not write `protocolVersion`/);
  const parsed = parseExampleFromLine(prompt, "Canonical final-line example");
  assert.equal(parsed.ok, true);
  assert.equal(parsed.event.v, 1);
  assert.equal(parsed.event.event, "DONE");
  assert.equal(parsed.event.eventId, "planning-discovery-R1-final");
  assert.deepEqual(parsed.event.payload, { stage: "DISCOVERY" });
});

test("worker and reviewer examples remain parseable canonical Orchestra v1 events", () => {
  const task = {
    id: "T1",
    title: "Demo task",
    objective: "Change one file.",
    kind: "code",
    dependencies: [],
    scope: { allow: ["index.html"], deny: [] },
    acceptanceCriteria: ["works"],
    verificationWaiver: "fixture",
    priority: 50,
    risk: "low",
    estimatedComplexity: "S"
  };
  const worker = WorkerPrompts.buildWorkerPrompt({
    project,
    task,
    runId: "WR1",
    agentId: "A2",
    gitAssignment: { required: false },
    packet: legacyPacket
  });
  assertCanonicalIdentity(worker, "worker");
  assert.equal(parseExampleFromLine(worker, "DONE example").ok, true);

  ContextPackets.setDefaultService(null);
  const review = ReviewPrompts.buildReviewPrompt({
    project,
    task,
    review: { reviewId: "RV1", authorAgentId: "A2" },
    packet: {},
    agentId: "A3"
  });
  assertCanonicalIdentity(review, "review");
  assert.equal(parseExampleFromLine(review, "APPROVED example").ok, true);
});

test("integrator and repair prompts retain canonical v1 identity", () => {
  const run = {
    projectId: "P1",
    runId: "I1",
    branch: "orchestra/P1/integration/I1",
    baseSha: "a".repeat(40),
    targetBranch: "main",
    taskOrder: [],
    mergeTaskIds: [],
    artifacts: [],
    verificationCommands: []
  };
  const integrator = IntegrationPrompts.buildIntegratorPrompt({ project, run, agentId: "A4", packet: legacyPacket });
  assertCanonicalIdentity(integrator, "integrator");

  const repair = IntegrationPrompts.buildRepairPrompt({
    project,
    run,
    repairTask: { repairTaskId: "IR1", attempt: 1, nextSequence: 2 },
    agentId: "A4",
    packet: legacyPacket
  });
  assertCanonicalIdentity(repair, "repair");
});
