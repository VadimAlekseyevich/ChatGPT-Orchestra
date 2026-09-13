const test = require("node:test");
const assert = require("node:assert/strict");

const MESSAGE_TYPES = require("../content/message-types.js");
const { OrchestratorApi, API_VERSION } = require("../background/orchestrator-api.js");

function makeApi() {
  const calls = [];
  const orchestrator = {
    getPublicState() { return { runtimeStatus: "pool_active", lead: { agentId: "L1", status: "IDLE" }, workers: [] }; },
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
    async startProject(payload) { calls.push(["startProject", payload]); return { ok: true, project: { projectId: "P1" } }; },
    async resumeCurrentStage(payload) { calls.push(["resumeLead", payload]); return { ok: true, resumed: true }; }
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
  const dashboard = {
    project: { projectId: "P1", status: "RUNNING" },
    tasks: [{ taskId: "T1", status: "READY" }],
    agents: [{ agentId: "A1", status: "IDLE" }],
    warnings: [{ code: "warn" }],
    metrics: { tasks: { total: 1 } },
    reviews: { items: [{ reviewId: "V1", taskId: "T1" }] },
    integration: { summary: { status: "IDLE" } }
  };
  const observabilityService = {
    dashboard() { return dashboard; },
    task(taskId) { return taskId === "T1" ? dashboard.tasks[0] : null; },
    agents() { return dashboard.agents; },
    warnings() { return dashboard.warnings; },
    metrics() { return dashboard.metrics; },
    debugBundle() { return { ok: true, filename: "debug.json", serialized: "{}" }; }
  };
  const taskControlService = {
    async retryTask(taskId) { calls.push(["retryTask", taskId]); return { ok: true }; },
    async cancelTask(taskId, options) { calls.push(["cancelTask", taskId, options]); return { ok: true }; },
    async changePriority(taskId, priority) { calls.push(["changePriority", taskId, priority]); return { ok: true }; },
    async reassignAgent(taskId, agentId) { calls.push(["reassignAgent", taskId, agentId]); return { ok: true }; },
    async requestReview(taskId) { calls.push(["requestReview", taskId]); return { ok: true }; },
    async startIntegration() { calls.push(["startIntegration"]); return { ok: true }; },
    async openExecutor(agentId) { calls.push(["openExecutor", agentId]); return { ok: true }; }
  };
  const contextStore = { summary: () => ({ projectId: "P1", decisionCount: 7, packetCount: 3 }) };
  const contextPackets = { packetForRole: (payload) => ({ ok: true, packet: { packetVersion: 1, packetType: payload.role, logicalRole: { logicalRoleId: `${payload.role}:P1` } } }) };
  return {
    calls,
    api: new OrchestratorApi({ orchestrator, planningEngine, schedulerEngine, reviewEngine, integrationEngine, recoveryController, eventBus, observabilityService, taskControlService, contextStore, contextPackets })
  };
}

test("Orchestrator API v4 exposes stable aggregated state DTO", async () => {
  const { api } = makeApi();
  assert.equal(API_VERSION, 4);
  const result = await api.query("state");
  assert.equal(result.apiVersion, API_VERSION);
  assert.equal(result.ok, true);
  assert.equal(result.state.project.projectId, "P1");
  assert.equal(result.state.scheduler.taskCount, 2);
  assert.equal(result.state.review.pending, 1);
  assert.equal(result.state.integration.status, "IDLE");
  assert.equal(result.state.recovery.bootReady, true);
  assert.equal(result.state.context.decisionCount, 7);
});

test("observability and context queries are available through one API surface", async () => {
  const { api } = makeApi();
  assert.equal((await api.query("dashboard")).dashboard.project.projectId, "P1");
  assert.equal((await api.query("taskGraph")).tasks.length, 1);
  assert.equal((await api.query("taskDetails", { taskId: "T1" })).task.taskId, "T1");
  assert.equal((await api.query("agents")).agents[0].agentId, "A1");
  assert.equal((await api.query("warnings")).warnings[0].code, "warn");
  assert.equal((await api.query("metrics")).metrics.tasks.total, 1);
  assert.equal((await api.query("reviewDetails", { reviewId: "V1" })).review.reviewId, "V1");
  assert.equal((await api.query("integrationEvidence")).integration.summary.status, "IDLE");
  assert.equal((await api.query("contextSummary")).context.packetCount, 3);
  const packet = await api.query("contextPacket", { role: "worker", taskId: "T1" });
  assert.equal(packet.ok, true);
  assert.equal(packet.packet.packetVersion, 1);
  assert.equal((await api.query("taskDetails", { taskId: "missing" })).reason, "unknown_task");
});

test("Dashboard task controls delegate through Core services", async () => {
  const { api, calls } = makeApi();
  for (const [name, payload] of [
    ["retryTask", { taskId: "T1" }],
    ["cancelTask", { taskId: "T1", cascade: true }],
    ["changePriority", { taskId: "T1", priority: 7 }],
    ["reassignAgent", { taskId: "T1", agentId: "A1" }],
    ["requestReview", { taskId: "T1" }],
    ["startIntegration", {}],
    ["openExecutor", { agentId: "A1" }],
    ["exportDebugBundle", {}]
  ]) assert.equal((await api.execute(name, payload)).ok, true, name);
  assert.ok(calls.some((item) => item[0] === "retryTask"));
  assert.ok(calls.some((item) => item[0] === "openExecutor"));
});

test("existing commands remain platform-neutral", async () => {
  const { api, calls } = makeApi();
  assert.equal((await api.execute("startProject", { goal: "do work", repositoryUrl: "https://github.com/a/b" })).ok, true);
  assert.equal((await api.execute("createWorkers", { count: 3 })).ok, true);
  assert.equal((await api.execute("pause")).ok, true);
  assert.deepEqual(calls[0], ["startProject", { goal: "do work", repositoryUrl: "https://github.com/a/b" }]);
  assert.deepEqual(calls[1], ["createWorkers", 3]);
  assert.deepEqual(calls[2], ["pause"]);
});

test("fresh Lead registration resumes an unfinished persisted planning role", async () => {
  const calls = [];
  const orchestrator = {
    getPublicState: () => ({ lead: null, workers: [] }),
    async registerActiveLead() { calls.push(["register"]); return { ok: true, agent: { agentId: "L-new" } }; }
  };
  const planningEngine = {
    getPublicState: () => ({ projectId: "P1", status: "PLANNING", stage: "CRITIQUE", currentRunId: "R1" }),
    async resumeCurrentStage(payload) { calls.push(["resume", payload]); return { ok: true, resumed: true, runId: "R1" }; }
  };
  const api = new OrchestratorApi({ orchestrator, planningEngine });
  const result = await api.execute("registerActiveLead");
  assert.equal(result.ok, true);
  assert.equal(result.planningResume.resumed, true);
  assert.deepEqual(calls, [["register"], ["resume", { reason: "fresh_lead_registered" }]]);
});

test("generic extension transport maps query and execute onto API v4", async () => {
  const { api, calls } = makeApi();
  const dashboard = await api.handleLegacyMessage({ type: MESSAGE_TYPES.ORCHESTRATOR_API_QUERY, payload: { name: "dashboard", payload: {} } }, { kind: "extension-ui", sessionId: null });
  assert.equal(dashboard.ok, true);
  assert.equal(dashboard.dashboard.project.projectId, "P1");
  const retry = await api.handleLegacyMessage({ type: MESSAGE_TYPES.ORCHESTRATOR_API_EXECUTE, payload: { name: "retryTask", payload: { taskId: "T1" } } }, { kind: "extension-ui", sessionId: null });
  assert.equal(retry.ok, true);
  assert.deepEqual(calls.at(-1), ["retryTask", "T1"]);
});

test("legacy extension messages remain compatibility transport", async () => {
  const { api, calls } = makeApi();
  const state = await api.handleLegacyMessage({ type: MESSAGE_TYPES.ORCHESTRATOR_GET_STATE }, { kind: "extension-ui", sessionId: null });
  assert.equal(state.ok, true);
  const workers = await api.handleLegacyMessage({ type: MESSAGE_TYPES.ORCHESTRATOR_CREATE_WORKERS, payload: { count: 4 } }, { kind: "extension-ui", sessionId: null });
  assert.equal(workers.ok, true);
  assert.deepEqual(calls.at(-1), ["createWorkers", 4]);
});

test("agent/browser sessions cannot issue privileged generic API commands", async () => {
  const { api } = makeApi();
  const result = await api.handleLegacyMessage(
    { type: MESSAGE_TYPES.ORCHESTRATOR_API_EXECUTE, payload: { name: "cancelTask", payload: { taskId: "T1" } } },
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