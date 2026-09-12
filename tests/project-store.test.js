const test = require("node:test");
const assert = require("node:assert/strict");
const { ProjectStore, normalizeRepositoryUrl } = require("../background/project-store.js");

function fakeStorage() {
  const data = {};
  return {
    data,
    async get(key) { return { [key]: data[key] }; },
    async set(values) { Object.assign(data, values); }
  };
}

test("normalizes only repository-root GitHub URLs", () => {
  assert.deepEqual(normalizeRepositoryUrl("https://github.com/acme/widget.git"), {
    url: "https://github.com/acme/widget",
    owner: "acme",
    repo: "widget",
    fullName: "acme/widget"
  });
  assert.equal(normalizeRepositoryUrl("http://github.com/acme/widget"), null);
  assert.equal(normalizeRepositoryUrl("https://github.com/acme/widget/issues/1"), null);
  assert.equal(normalizeRepositoryUrl("https://example.com/acme/widget"), null);
});

test("persists immutable project bootstrap input and blocks a second active project", async () => {
  const storage = fakeStorage();
  const store = new ProjectStore({ storageArea: storage, idFactory: () => "P1", clock: () => 100 });
  await store.load();
  const created = await store.createProject({
    goal: "Implement a deterministic project planning workflow.",
    repositoryUrl: "https://github.com/acme/widget"
  });
  assert.equal(created.ok, true);
  assert.equal(created.project.projectId, "P1");
  assert.equal(created.project.initialGoal, "Implement a deterministic project planning workflow.");
  assert.equal(created.project.repository.fullName, "acme/widget");

  const second = await store.createProject({
    goal: "This is another valid project goal that should be rejected.",
    repositoryUrl: "https://github.com/acme/other"
  });
  assert.equal(second.ok, false);
  assert.equal(second.reason, "active_project_in_progress");

  const restored = new ProjectStore({ storageArea: storage, idFactory: () => "P2" });
  await restored.load();
  assert.equal(restored.getActiveProject().projectId, "P1");
});

test("stage completion is idempotent for the same stage and run", async () => {
  let now = 10;
  const store = new ProjectStore({ storageArea: fakeStorage(), idFactory: () => "P1", clock: () => now++ });
  await store.load();
  await store.createProject({
    goal: "Make stage recovery idempotent when replaying an accepted event.",
    repositoryUrl: "https://github.com/acme/widget"
  });
  await store.beginStage("P1", { stage: "DISCOVERY", runId: "R1" });
  await store.completeStage("P1", { stage: "DISCOVERY", artifact: { value: 1 } });
  await store.completeStage("P1", { stage: "DISCOVERY", artifact: { value: 1 } });
  const project = store.getProject("P1");
  assert.equal(project.stageHistory.filter((entry) => entry.status === "completed").length, 1);
  assert.deepEqual(project.artifacts.DISCOVERY, { value: 1 });
});

test("rejects invalid bootstrap input", async () => {
  const store = new ProjectStore({ storageArea: fakeStorage(), idFactory: () => "P1" });
  await store.load();
  assert.equal((await store.createProject({ goal: "short", repositoryUrl: "https://github.com/acme/widget" })).reason, "goal_too_short");
  assert.equal((await store.createProject({ goal: "A sufficiently detailed goal for this test.", repositoryUrl: "not-a-repo" })).reason, "invalid_repository_url");
});
