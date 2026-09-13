const test = require("node:test");
const assert = require("node:assert/strict");

require("../prompts/planning-prompts.js");
const { PlanningEngine } = require("../background/planning-engine.js");

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function activeProject() {
  return {
    projectId: "P1",
    status: "PLANNING",
    stage: "CRITIQUE",
    currentRunId: "planning-critique-persisted",
    initialGoal: "Implement portable context packets",
    repository: { url: "https://github.com/acme/demo" },
    artifacts: {
      DISCOVERY: { repositoryAccess: { status: "ok", inspectedPaths: ["package.json"] }, commands: {}, stack: ["JS"] },
      PLAN_V1: { milestones: [{ id: "M1", objective: "packets", dependencies: [] }], completionDefinition: "done" }
    },
    stageHistory: []
  };
}

test("fresh Lead resumes the same persisted planning role without creating a new run", async () => {
  const project = activeProject();
  let beginStageCalls = 0;
  const projectStore = {
    async load() {},
    getActiveProject: () => clone(project),
    getProject: () => clone(project),
    summary: () => ({ projectId: project.projectId, status: project.status, stage: project.stage, currentRunId: project.currentRunId }),
    async beginStage() { beginStageCalls += 1; throw new Error("replacement_must_not_begin_new_stage"); }
  };
  const lead = { agentId: "LEAD-NEW", role: "lead", status: "IDLE" };
  const contexts = [];
  const registry = {
    listAgents: () => [clone(lead)],
    isAgentConnected: () => true,
    async setProtocolContext(agentId, context) { contexts.push({ agentId, context: clone(context) }); return { ...lead, protocolContext: clone(context) }; },
    async clearProtocolContext() { throw new Error("must_not_clear_successful_context"); }
  };
  const eventBus = { subscribe: () => () => {}, recent: () => ({ events: [] }) };
  const prompts = [];
  const engine = new PlanningEngine({ projectStore, registry, eventBus, sendPrompt: async (agentId, prompt) => { prompts.push({ agentId, prompt }); return { ok: true }; } });

  const result = await engine.resumeCurrentStage({ reason: "test_replacement" });
  assert.equal(result.ok, true);
  assert.equal(result.resumed, true);
  assert.equal(result.runId, "planning-critique-persisted");
  assert.equal(result.stage, "CRITIQUE");
  assert.equal(result.logicalRoleId, "lead:P1:CRITIQUE");
  assert.equal(beginStageCalls, 0);
  assert.deepEqual(contexts.at(-1), {
    agentId: "LEAD-NEW",
    context: { projectId: "P1", taskId: "planning:critique", runId: "planning-critique-persisted" }
  });
  assert.equal(prompts.length, 1);
  assert.ok(prompts[0].prompt.includes("fresh-session replacement"));
  assert.ok(prompts[0].prompt.includes("PORTABLE CONTEXT PACKET"));
  assert.ok(prompts[0].prompt.includes("planning-critique-persisted"));
});

test("failed fresh Lead dispatch clears protocol binding so registration can retry safely", async () => {
  const project = activeProject();
  const lead = { agentId: "LEAD-NEW", role: "lead", status: "CONNECTING" };
  const operations = [];
  const registry = {
    listAgents: () => [clone(lead)],
    isAgentConnected: () => true,
    async setProtocolContext(agentId, context) { operations.push(["set", agentId, clone(context)]); return { ...lead, protocolContext: clone(context) }; },
    async clearProtocolContext(agentId) { operations.push(["clear", agentId]); return { ...lead, protocolContext: null }; }
  };
  const projectStore = {
    getActiveProject: () => clone(project),
    summary: () => ({ projectId: project.projectId, status: project.status, stage: project.stage, currentRunId: project.currentRunId })
  };
  const engine = new PlanningEngine({
    projectStore,
    registry,
    eventBus: {},
    sendPrompt: async () => ({ ok: false, reason: "content_not_ready" })
  });
  const result = await engine.resumeCurrentStage({ reason: "test_retryable_delivery" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "lead_replacement_prompt_failed");
  assert.equal(result.retryable, true);
  assert.deepEqual(operations.at(-1), ["clear", "LEAD-NEW"]);
});

test("Lead replacement fails closed when there is no active persisted planning role", async () => {
  const projectStore = {
    getActiveProject: () => ({ projectId: "P1", status: "READY", stage: "READY", currentRunId: null }),
    summary: () => ({ projectId: "P1", status: "READY" })
  };
  const registry = { listAgents: () => [{ agentId: "L1", role: "lead", status: "IDLE" }], isAgentConnected: () => true };
  const engine = new PlanningEngine({ projectStore, registry, eventBus: {}, sendPrompt: async () => ({ ok: true }) });
  const result = await engine.resumeCurrentStage();
  assert.equal(result.ok, false);
  assert.equal(result.reason, "planning_role_not_active");
});
