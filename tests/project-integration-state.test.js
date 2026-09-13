const test = require("node:test");
const assert = require("node:assert/strict");
const { ProjectStore } = require("../background/project-store.js");

function fakeStorage() {
  const data = {};
  return { async get(key) { return { [key]: data[key] }; }, async set(values) { Object.assign(data, values); } };
}

test("READY_FOR_INTEGRATION remains active while INTEGRATION_VERIFIED is terminal for starting a new project", async () => {
  let id = 0;
  const store = new ProjectStore({ storageArea: fakeStorage(), idFactory: () => `P${++id}` });
  await store.load();
  const first = await store.createProject({ goal: "Build and integrate a safely reviewed change set.", repositoryUrl: "https://github.com/acme/widget" });
  assert.equal(first.ok, true);
  await store.setExecutionStatus("P1", "READY_FOR_INTEGRATION", { phase: 7 });
  const blocked = await store.createProject({ goal: "Another valid project that must wait for integration.", repositoryUrl: "https://github.com/acme/other" });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, "active_project_in_progress");

  await store.setExecutionStatus("P1", "INTEGRATION_VERIFIED", { phase: 8, integration: { branch: "orchestra/P1/integration/I1" } });
  assert.equal(store.getProject("P1").stage, "INTEGRATION_COMPLETE");
  const second = await store.createProject({ goal: "Another valid project after integration is verified.", repositoryUrl: "https://github.com/acme/other" });
  assert.equal(second.ok, true);
  assert.equal(second.project.projectId, "P2");
});
