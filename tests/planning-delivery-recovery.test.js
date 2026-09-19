const test = require("node:test");
const assert = require("node:assert/strict");

const { ManagedBrowserCompletionMonitor } = require("../apps/desktop/main/managed-browser-completion-monitor.js");
const { PlanningEngine } = require("../background/planning-engine.js");
const { OrchestratorApi } = require("../background/orchestrator-api.js");

const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};
root.PlanningPrompts = {
  STAGES: ["DISCOVERY", "PLAN_V1", "CRITIQUE", "PLAN_V2", "DECOMPOSE", "DAG_CRITIC"],
  buildPlanningPrompt: ({ stage, runId, replacement = false }) => `${replacement ? "replacement" : "initial"}:${stage}:${runId}`
};

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function makeProjectStore(initial) {
  const state = clone(initial);
  return {
    state,
    getActiveProject: () => clone(state),
    getProject: (projectId) => projectId === state.projectId ? clone(state) : null,
    summary: () => ({
      projectId: state.projectId,
      status: state.status,
      stage: state.stage,
      currentRunId: state.currentRunId,
      repository: state.repository,
      goal: state.initialGoal,
      lastError: state.lastError || null
    }),
    async clearError(projectId) {
      assert.equal(projectId, state.projectId);
      delete state.lastError;
      return clone(state);
    },
    async beginStage(projectId, { stage, runId }) {
      assert.equal(projectId, state.projectId);
      state.status = "PLANNING";
      state.stage = stage;
      state.currentRunId = runId;
      return clone(state);
    },
    async fail(projectId, reason, details = null, status = "NEEDS_USER") {
      assert.equal(projectId, state.projectId);
      state.status = status;
      state.lastError = { reason, details: clone(details) };
      return clone(state);
    }
  };
}

function makeRegistry() {
  const lead = { agentId: "L1", role: "lead", status: "IDLE", protocolContext: null };
  const operations = [];
  return {
    lead,
    operations,
    listAgents: () => [clone(lead)],
    isAgentConnected: () => true,
    async setProtocolContext(agentId, context) {
      lead.protocolContext = clone(context);
      operations.push(["set", agentId, clone(context)]);
      return clone(lead);
    },
    async clearProtocolContext(agentId) {
      lead.protocolContext = null;
      operations.push(["clear", agentId]);
      return clone(lead);
    }
  };
}

test("completion monitor retries a transient preload timeout before giving up on baseline", async () => {
  let reads = 0;
  const driver = {
    async readAssistantSnapshot() {
      reads += 1;
      if (reads === 1) return { ok: false, reason: "agent_preload_timeout" };
      return {
        ok: true,
        text: "",
        fingerprint: "",
        messageCount: 0,
        pathname: "/",
        url: "https://chatgpt.com/",
        availability: "ready",
        generating: false
      };
    }
  };
  const monitor = new ManagedBrowserCompletionMonitor({
    driver,
    protocolAdapter: {
      async publishCompletion() { return { ok: true }; },
      async publishProtocolError() { return { ok: true }; }
    },
    prepareAttempts: 2,
    prepareRetryMs: 1,
    sleep: async () => {}
  });
  const runtime = {
    getAgent: () => ({ agentId: "L1" }),
    sessionIdForAgent: () => "S1"
  };

  const result = await monitor.prepare(runtime, "L1");
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
  assert.equal(reads, 2);
});

test("initial planning prompt delivery failure stays PLANNING and clears binding for safe retry", async () => {
  const projectStore = makeProjectStore({
    projectId: "P1",
    status: "BOOTSTRAPPING",
    stage: "BOOTSTRAP",
    currentRunId: null,
    initialGoal: "Create a simple counter page",
    repository: { url: "https://github.com/acme/demo" }
  });
  const registry = makeRegistry();
  const engine = new PlanningEngine({
    projectStore,
    registry,
    eventBus: {},
    idFactory: () => "fixed",
    sendPrompt: async () => ({ ok: false, reason: "agent_preload_timeout" })
  });

  const result = await engine.dispatchStage("P1", "DISCOVERY");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "lead_prompt_failed");
  assert.equal(result.retryable, true);
  assert.equal(projectStore.state.status, "PLANNING");
  assert.equal(projectStore.state.stage, "DISCOVERY");
  assert.equal(projectStore.state.currentRunId, "planning-discovery-fixed");
  assert.equal(projectStore.state.lastError.reason, "lead_prompt_failed");
  assert.deepEqual(registry.operations.at(-1), ["clear", "L1"]);
});

test("legacy NEEDS_USER caused by lead prompt delivery can resume the same planning run", async () => {
  const projectStore = makeProjectStore({
    projectId: "P1",
    status: "NEEDS_USER",
    stage: "DISCOVERY",
    currentRunId: "planning-discovery-existing",
    initialGoal: "Create a simple counter page",
    repository: { url: "https://github.com/acme/demo" },
    lastError: { reason: "lead_prompt_failed", details: { reason: "agent_preload_timeout" } }
  });
  const registry = makeRegistry();
  const prompts = [];
  const engine = new PlanningEngine({
    projectStore,
    registry,
    eventBus: {},
    sendPrompt: async (agentId, prompt) => { prompts.push({ agentId, prompt }); return { ok: true }; }
  });

  const result = await engine.resumeCurrentStage({ reason: "test_legacy_timeout_recovery" });
  assert.equal(result.ok, true);
  assert.equal(result.resumed, true);
  assert.equal(result.runId, "planning-discovery-existing");
  assert.equal(projectStore.state.status, "PLANNING");
  assert.equal(prompts.length, 1);
  assert.match(prompts[0].prompt, /replacement:DISCOVERY:planning-discovery-existing/);
});

test("Lead registration attempts recovery for an interrupted NEEDS_USER planning delivery even with old binding present", async () => {
  const calls = [];
  const exactContext = { projectId: "P1", taskId: "planning:discovery", runId: "R1" };
  const orchestrator = {
    getPublicState: () => ({ lead: { agentId: "L1", status: "IDLE", protocolContext: exactContext }, workers: [] }),
    async registerActiveLead() { calls.push(["register"]); return { ok: true, agent: { agentId: "L1" } }; }
  };
  const planningEngine = {
    getPublicState: () => ({ projectId: "P1", status: "NEEDS_USER", stage: "DISCOVERY", currentRunId: "R1" }),
    async resumeCurrentStage(payload) { calls.push(["resume", payload]); return { ok: true, resumed: true, runId: "R1" }; }
  };
  const api = new OrchestratorApi({ orchestrator, planningEngine });

  const result = await api.execute("registerActiveLead");
  assert.equal(result.ok, true);
  assert.equal(result.planningResume.resumed, true);
  assert.deepEqual(calls, [["register"], ["resume", { reason: "fresh_lead_registered" }]]);
});


test("retryable PLANNING delivery failure resumes the same run and clears stale error", async () => {
  const projectStore = makeProjectStore({
    projectId: "P1",
    status: "PLANNING",
    stage: "PLAN_V1",
    currentRunId: "planning-plan_v1-existing",
    initialGoal: "Create a simple counter page",
    repository: { url: "https://github.com/acme/demo" },
    lastError: { reason: "lead_prompt_failed", details: { reason: "agent_preload_timeout" } }
  });
  const registry = makeRegistry();
  const prompts = [];
  const engine = new PlanningEngine({
    projectStore,
    registry,
    eventBus: {},
    sendPrompt: async (agentId, prompt) => {
      prompts.push({ agentId, prompt });
      return { ok: true, accepted: true };
    }
  });

  const result = await engine.resumeCurrentStage({ reason: "manual_retry" });
  assert.equal(result.ok, true);
  assert.equal(result.runId, "planning-plan_v1-existing");
  assert.equal(projectStore.state.lastError, undefined);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0].prompt, /replacement:PLAN_V1:planning-plan_v1-existing/);
});

test("retryPlanning API is gated to a persisted lead delivery failure", async () => {
  const calls = [];
  const planningEngine = {
    getPublicState: () => ({
      projectId: "P1",
      status: "PLANNING",
      stage: "PLAN_V1",
      currentRunId: "R1",
      lastError: { reason: "lead_prompt_failed", details: { reason: "agent_preload_timeout" } }
    }),
    async resumeCurrentStage(payload) {
      calls.push(payload);
      return { ok: true, resumed: true, runId: "R1" };
    }
  };
  const api = new OrchestratorApi({ orchestrator: {}, planningEngine });
  const result = await api.execute("retryPlanning");
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [{ reason: "manual_retry" }]);
});
