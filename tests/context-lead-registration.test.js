const test = require("node:test");
const assert = require("node:assert/strict");

const { OrchestratorApi } = require("../background/orchestrator-api.js");

function planningState() {
  return { projectId: "P1", status: "PLANNING", stage: "CRITIQUE", currentRunId: "R1" };
}

function makeApi(beforeLead) {
  const calls = [];
  const orchestrator = {
    getPublicState: () => ({ lead: beforeLead, workers: [] }),
    async registerActiveLead() { calls.push(["register"]); return { ok: true, agent: { agentId: "L1" } }; }
  };
  const planningEngine = {
    getPublicState: () => planningState(),
    async resumeCurrentStage(payload) { calls.push(["resume", payload]); return { ok: true, resumed: true, runId: "R1" }; }
  };
  return { api: new OrchestratorApi({ orchestrator, planningEngine }), calls };
}

test("absent Lead registration resumes persisted planning role", async () => {
  const { api, calls } = makeApi(null);
  const result = await api.execute("registerActiveLead");
  assert.equal(result.ok, true);
  assert.equal(result.planningResume.resumed, true);
  assert.deepEqual(calls, [["register"], ["resume", { reason: "fresh_lead_registered" }]]);
});

test("already live Lead with exact planning protocol context is not replayed", async () => {
  const { api, calls } = makeApi({
    agentId: "L1",
    status: "IDLE",
    protocolContext: { projectId: "P1", taskId: "planning:critique", runId: "R1" }
  });
  const result = await api.execute("registerActiveLead");
  assert.equal(result.ok, true);
  assert.equal(result.planningResume, undefined);
  assert.deepEqual(calls, [["register"]]);
});

test("Lead with missing planning binding retries replacement bootstrap", async () => {
  const { api, calls } = makeApi({ agentId: "L1", status: "IDLE", protocolContext: null });
  const result = await api.execute("registerActiveLead");
  assert.equal(result.ok, true);
  assert.equal(result.planningResume.resumed, true);
  assert.deepEqual(calls, [["register"], ["resume", { reason: "fresh_lead_registered" }]]);
});
