"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { ProjectStore } = require("../background/project-store.js");
const { createLocalPlanningEngine } = require("../apps/desktop/main/local-planning-engine.js");

function storage() {
  const data = {};
  return {
    async get(key) { return { [key]: data[key] }; },
    async set(values) { Object.assign(data, values); }
  };
}

test("project persists only logical repositoryId and never a filesystem path", async () => {
  const store = new ProjectStore({ storageArea: storage(), idFactory: () => "P1", clock: () => 1 });
  await store.load();
  const created = await store.createProject({
    goal: "Build a safe repository-bound project.",
    repositoryUrl: "https://github.com/acme/widget",
    repositoryId: "repo-local-1"
  });
  assert.equal(created.ok, true);
  assert.deepEqual(created.project.repositoryRuntime, { repositoryId: "repo-local-1" });
  assert.deepEqual(store.summary().repositoryRuntime, { repositoryId: "repo-local-1" });
  assert.equal(JSON.stringify(created.project).includes("workspaces"), false);
  assert.equal(JSON.stringify(created.project).includes("C:\\"), false);
});

test("invalid local repository id is rejected without changing portable repository URL", async () => {
  const store = new ProjectStore({ storageArea: storage(), idFactory: () => "P1" });
  await store.load();
  const rejected = await store.createProject({
    goal: "Build a safe repository-bound project.",
    repositoryUrl: "https://github.com/acme/widget",
    repositoryId: "../outside"
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, "invalid_repository_id");
});

test("desktop local planning engine forwards repositoryId into ProjectStore before discovery", async () => {
  class BasePlanningEngine {
    constructor({ projectStore }) { this.projectStore = projectStore; }
    getLead() { return { agentId: "L1" }; }
    isConnected() { return true; }
    async dispatchStage(projectId, stage) { return { ok: true, projectId, stage }; }
  }
  const LocalPlanningEngine = createLocalPlanningEngine(BasePlanningEngine);
  const calls = [];
  const projectStore = {
    async createProject(payload) { calls.push(payload); return { ok: true, project: { projectId: "P1" } }; }
  };
  const engine = new LocalPlanningEngine({ projectStore });
  const result = await engine.startProject({ goal: "Bound project goal", repositoryUrl: "https://github.com/acme/widget", repositoryId: "repo-1" });
  assert.equal(result.ok, true);
  assert.equal(result.stage, "DISCOVERY");
  assert.equal(calls[0].repositoryId, "repo-1");
});
