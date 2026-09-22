"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

require("../prompts/planning-prompts.js");
const { ProjectStore } = require("../background/project-store.js");
const { PlanningEngine } = require("../background/planning-engine.js");
require("../background/recovery-hooks.js");

function fakeStorage() {
  const data = {};
  return {
    async get(key) { return { [key]: data[key] }; },
    async set(values) { Object.assign(data, values); }
  };
}

class FakeEventBus {
  subscribe() { return () => {}; }
  allEvents() { return []; }
  recent() { return { events: [], rejections: [] }; }
}

test("recovery resume turns planning_timeout into a fresh planning run instead of waiting for the dead run", async () => {
  const store = new ProjectStore({ storageArea: fakeStorage(), idFactory: () => "P-timeout" });
  await store.load();
  await store.createProject({
    goal: "Recover a timed out planning stage with a fresh durable run.",
    repositoryUrl: "https://github.com/acme/widget"
  });
  await store.beginStage("P-timeout", { stage: "DISCOVERY", runId: "planning-discovery-dead" });
  await store.fail("P-timeout", "planning_timeout", {
    stage: "DISCOVERY",
    runId: "planning-discovery-dead",
    retryable: true,
    retryMode: "fresh_run"
  }, "PLANNING");

  const lead = { agentId: "A1", role: "lead", status: "IDLE", tabId: null, chatState: { availability: "ready", generating: false, composerOccupied: false } };
  const registry = {
    listAgents() { return [{ ...lead, protocolContext: lead.protocolContext ? { ...lead.protocolContext } : null }]; },
    isAgentConnected(agent) { return Boolean(agent && agent.status !== "OFFLINE"); },
    async pingAgent() { return { ok: true, availability: "ready", generating: false, composerOccupied: false, agent: { ...lead } }; },
    async setProtocolContext(_agentId, context) { lead.protocolContext = { ...context }; return { ...lead }; },
    async clearProtocolContext() { lead.protocolContext = null; }
  };
  const prompts = [];
  const engine = new PlanningEngine({
    projectStore: store,
    registry,
    eventBus: new FakeEventBus(),
    idFactory: () => "fresh-after-timeout",
    sendPrompt: async (agentId, prompt) => { prompts.push({ agentId, prompt }); return { ok: true }; }
  });
  await engine.init();

  const result = await engine.resumeAfterRecovery();
  const project = store.getActiveProject();
  assert.equal(result.ok, true);
  assert.equal(result.freshRun, true);
  assert.equal(result.previousRunId, "planning-discovery-dead");
  assert.equal(project.stage, "DISCOVERY");
  assert.notEqual(project.currentRunId, "planning-discovery-dead");
  assert.equal(project.currentRunId, "planning-discovery-fresh-after-timeout");
  assert.equal(prompts.length, 1);
  assert.match(prompts[0].prompt, /planning stage DISCOVERY/);
  assert.match(prompts[0].prompt, /planning_timeout/);
});
