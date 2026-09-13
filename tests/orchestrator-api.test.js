const test = require("node:test");
const assert = require("node:assert/strict");

const MESSAGE_TYPES = require("../content/message-types.js");
const { OrchestratorApi, API_VERSION } = require("../background/orchestrator-api.js");

function makeApi() {
  const calls = [];
  const orchestrator = {
    getPublicState() { return { runtimeStatus: "pool_active", lead: { agentId: "L1" }, workers: [] }; },
    async startExecution(payload) { calls.push(["startExecution", payload]); return { ok: true, started: true }; },
    async registerActiveLead() { calls.push(["registerActiveLead"]); return { ok: true }; },
    async createWorkers(count) { calls.push(["createWorkers", count]); return { ok: true, created: [] }; },
    async bindProtocolContext(agentId, context) { calls.push(["bindProtocolContext", agentId, context]); return { ok: true }; },
    async clearProtocolContext(agentId) { calls.push(["clearProtocolContext", agentId]); return { ok: true }; },
    async sendPromptToAgent(agentId, prompt) { calls.push(["sendAgentPrompt", agentId, prompt]); return { ok: true }; },
    async stopAgent(agentId) { calls.push(["stopAgent", agentId]); return { ok: true }; }
  };
  const planningEngine = {
    getPublicState() { return { projectId: "P1", status: "READY" }; },
    async startProject(payload) { calls.push(["startProject", payload]); return { ok: true, project: { projectId: "P1" } }; }
  };
  const schedulerEngine = {
    getPublicState() { return { status: "RUNNING", taskCount: 2 }; },
    getRecentDecisions(limit) { return [{ limit }]; },
    async tick(payload) { calls.push(["schedulerTick", payload]); return { ok: true }; }
  };
  const reviewEngine = { getPublicState() { return { pending: 1 }; } };
  const integrationEngine = { getPublicState() { return { status: "IDLE" }; } };
  const recoveryController = {
    getPublicState() { return { status: "RUNNING", bootReady: true }; },
    async pause() { calls.push(["pause"]); return { ok: true }; },
    async stopNow() { calls.push(["stopNow"]); return { ok: true }; },
    async resume() { calls.push(["resume"]); return { ok: true }; }
  };
  const eventBus = { recent(limit) { return { events: [{ cursor: 1, limit }], rejections: [] }; } };
  return {
    calls,
    api: new OrchestratorApi({ orchestrator, planningEngine, schedulerEngine, reviewEngine, integrationEngine, recoveryController, eventBus })
  };
}

test("Orchestrator API exposes stable aggregated state DTO", async () => {
  const { api } = makeApi();
  const result = await api.query("state");
  assert.equal(result.apiVersion, API_VERSION);
  assert.equal(result.ok, true);
  assert.equal(result.state.project.projectId, "P1");
  assert.equal(result.state.scheduler.taskCount, 2);
  assert.equal(result.state.review.pending, 1);
  assert.equal(result.state.integration.status, "IDLE");
  assert.equal(result.state.recovery.bootReady, true);
});

test("Orchestrator API commands delegate without platform sender objects", async () => {
  const { api, calls } = makeApi();
  assert.equal((await api.execute("startProject", { goal: "do work", repositoryUrl: "https://github.com/a/b" })).ok, true);
  assert.equal((await api.execute("createWorkers", { count: 3 })).ok, true);
  assert.equal((await api.execute("pause")).ok, true);
  assert.deepEqual(calls[0], ["startProject", { goal: "do work", repositoryUrl: "https://github.com/a/b" }]);
  assert.deepEqual(calls[1], ["createWorkers", 3]);
  assert.deepEqual(calls[2], ["pause"]);
});

test("legacy extension messages are only a transport mapping onto Orchestrator API", async () => {
  const { api, calls } = makeApi();
  const state = await api.handleLegacyMessage({ type: MESSAGE_TYPES.ORCHESTRATOR_GET_STATE }, { kind: "extension-ui", sessionId: null });
  assert.equal(state.ok, true);
  assert.equal(state.apiVersion, API_VERSION);

  const workers = await api.handleLegacyMessage({ type: MESSAGE_TYPES.ORCHESTRATOR_CREATE_WORKERS, payload: { count: 4 } }, { kind: "extension-ui", sessionId: null });
  assert.equal(workers.ok, true);
  assert.deepEqual(calls.at(-1), ["createWorkers", 4]);
});

test("agent/browser sessions cannot issue privileged Orchestrator API commands", async () => {
  const { api } = makeApi();
  const result = await api.handleLegacyMessage(
    { type: MESSAGE_TYPES.ORCHESTRATOR_STOP_NOW },
    { kind: "agent-session", sessionId: "42", agentId: "A1" }
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "orchestrator_command_forbidden_from_agent_session");
});

test("unknown API names fail closed", async () => {
  const { api } = makeApi();
  assert.equal((await api.query("futureQuery")).reason, "unknown_api_query");
  assert.equal((await api.execute("futureCommand")).reason, "unknown_api_command");
});
