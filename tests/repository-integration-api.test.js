"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { OrchestratorApi } = require("../background/orchestrator-api.js");

test("Orchestrator API routes deterministic merge and guarded push through repository service", async () => {
  const calls = [];
  const repositoryService = {
    async mergeTaskArtifact(payload) {
      calls.push(["mergeTaskArtifact", payload]);
      return { ok: true, merge: { head: "a".repeat(40), parents: ["b".repeat(40), payload.taskCommit] } };
    },
    async pushWorkspace(payload) {
      calls.push(["pushWorkspace", payload]);
      return { ok: true, push: { branch: "orchestra/P/integration/I" } };
    }
  };
  const api = new OrchestratorApi({ repositoryService });

  const merged = await api.execute("mergeTaskArtifact", {
    projectId: "P",
    repositoryId: "R",
    integrationWorkspaceId: "integration:P:I",
    taskCommit: "c".repeat(40)
  });
  assert.equal(merged.ok, true);
  assert.equal(merged.merge.parents.length, 2);

  const pushed = await api.execute("pushWorkspace", {
    projectId: "P",
    repositoryId: "R",
    workspaceId: "integration:P:I",
    validated: true
  });
  assert.equal(pushed.ok, true);
  assert.deepEqual(calls.map((item) => item[0]), ["mergeTaskArtifact", "pushWorkspace"]);
});

test("integration repository commands fail closed without desktop repository service", async () => {
  const api = new OrchestratorApi({});
  assert.equal((await api.execute("mergeTaskArtifact", {})).reason, "api_dependency_unavailable");
  assert.equal((await api.execute("pushWorkspace", {})).reason, "api_dependency_unavailable");
});
