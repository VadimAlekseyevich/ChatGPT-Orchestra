const test = require("node:test");
const assert = require("node:assert/strict");

require("../background/git-provider.js");
require("../background/integration-policy.js");
require("../prompts/integration-prompts.js");
require("../background/integration-store.js");
require("../background/integration-engine.js");
const { RecoverableIntegrationEngine } = require("../background/integration-recovery.js");
const { IntegrationStore } = require("../background/integration-store.js");

function fakeStorage() {
  const data = {};
  return { async get(key) { return { [key]: data[key] }; }, async set(values) { Object.assign(data, values); } };
}

class FakeEventBus { subscribe() { return () => {}; } }

function runSpec() {
  return {
    projectId: "P1", runId: "I-old", branch: "orchestra/P1/integration/I-old",
    baseSha: "a".repeat(40), targetBranch: "main", taskOrder: ["T1"], mergeTaskIds: ["T1"],
    artifacts: [{ taskId: "T1", branch: "task", commit: "b".repeat(40), changedFiles: ["src/a.js"] }],
    verificationCommands: ["npm test"]
  };
}

test("ambiguous ASSIGNED integration run is abandoned instead of replaying prompt after restart", async () => {
  const storage = fakeStorage();
  const seed = new IntegrationStore({ storageArea: storage });
  await seed.load();
  await seed.createRun(runSpec());
  await seed.assign("I-old", "A1");

  const registry = {
    async clearProtocolContext() { return true; },
    getAgent() { return { agentId: "A1", role: "worker", tabId: 10, status: "IDLE" }; },
    listAgents() { return []; }
  };
  const schedulerStore = {
    state: { status: "INTEGRATING" },
    summary() { return { status: this.state.status, projectId: "P1" }; },
    async setStatus(status) { this.state.status = status; },
    listTasks() { return []; },
    getGitSnapshot() { return { defaultBranch: "main", baseSha: "a".repeat(40) }; },
    async logDecision() {}
  };
  const projectStore = {
    project: { projectId: "P1", status: "INTEGRATING" },
    getActiveProject() { return { ...this.project }; },
    async setExecutionStatus(_id, status, details) { this.project.status = status; this.project.execution = { details }; }
  };
  const store = new IntegrationStore({ storageArea: storage });
  const engine = new RecoverableIntegrationEngine({
    store, schedulerStore, projectStore, registry, eventBus: new FakeEventBus(),
    gitProvider: { async checkBaseFresh() { return { ok: true }; } },
    sendPrompt: async () => { throw new Error("must not replay ambiguous prompt"); }
  });
  await store.load();
  await engine.restoreActiveRun();
  assert.equal(store.getRun("I-old").status, "ABANDONED");
  assert.equal(store.currentRun(), null);
  assert.equal(schedulerStore.state.status, "READY_FOR_INTEGRATION");
  assert.equal(projectStore.project.status, "READY_FOR_INTEGRATION");
});
