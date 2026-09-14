"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const Contracts = require("../platform/contracts.js");
const { OrchestratorApi, API_VERSION } = require("../background/orchestrator-api.js");

function fakeRepositoryService() {
  const calls = [];
  const service = {
    async listRepositories() { calls.push(["listRepositories"]); return { ok: true, repositories: [{ repositoryId: "repo-1", trust: "UNTRUSTED" }] }; },
    async getRepository(repositoryId) { calls.push(["getRepository", repositoryId]); return { ok: true, repository: { repositoryId } }; },
    async workspaceStatus(payload) { calls.push(["workspaceStatus", payload]); return { ok: true, status: { workspaceId: payload.workspaceId, clean: true } }; },
    async workspaceDiff(payload) { calls.push(["workspaceDiff", payload]); return { ok: true, diff: { changedFiles: [] } }; },
    async workspaceScope(payload) { calls.push(["workspaceScope", payload]); return { ok: true, scope: { ok: true, violations: [] } }; },
    async openLocalRepository(payload) { calls.push(["openLocalRepository", payload]); return { ok: true, repository: { repositoryId: payload.repositoryId } }; },
    async cloneRepository(payload) { calls.push(["cloneRepository", payload]); return { ok: true, repository: { repositoryId: payload.repositoryId } }; },
    async setRepositoryTrust(payload) { calls.push(["setRepositoryTrust", payload]); return { ok: true, repository: { repositoryId: payload.repositoryId, trust: payload.trust } }; },
    async createTaskWorkspace(payload) { calls.push(["createTaskWorkspace", payload]); return { ok: true, workspace: { workspaceId: "task:P:T:R" } }; },
    async createIntegrationWorkspace(payload) { calls.push(["createIntegrationWorkspace", payload]); return { ok: true, workspace: { workspaceId: "integration:P:R" } }; },
    async verifyWorkspace(payload) { calls.push(["verifyWorkspace", payload]); return { ok: true, verification: { status: "passed" } }; },
    async commitWorkspace(payload) { calls.push(["commitWorkspace", payload]); return { ok: true, commit: { sha: "a".repeat(40) } }; },
    async cleanupWorkspace(payload) { calls.push(["cleanupWorkspace", payload]); return { ok: true, workspaceId: payload.workspaceId }; }
  };
  return { service, calls };
}

test("Phase 17 repository/workspace surfaces are declared platform API contracts", () => {
  for (const query of ["repositories", "repository", "workspaceStatus", "workspaceDiff", "workspaceScope"]) {
    assert.ok(Contracts.API_QUERIES.includes(query), query);
  }
  for (const command of [
    "openLocalRepository",
    "cloneRepository",
    "setRepositoryTrust",
    "createTaskWorkspace",
    "createIntegrationWorkspace",
    "verifyWorkspace",
    "commitWorkspace",
    "cleanupWorkspace"
  ]) assert.ok(Contracts.API_COMMANDS.includes(command), command);
});

test("Orchestrator API routes repository queries without exposing filesystem adapters", async () => {
  const { service, calls } = fakeRepositoryService();
  const api = new OrchestratorApi({ repositoryService: service });

  const listed = await api.query("repositories");
  assert.equal(listed.apiVersion, API_VERSION);
  assert.equal(listed.ok, true);
  assert.equal(listed.repositories[0].repositoryId, "repo-1");

  assert.equal((await api.query("repository", { repositoryId: "repo-1" })).ok, true);
  assert.equal((await api.query("workspaceStatus", { workspaceId: "W1" })).status.clean, true);
  assert.deepEqual((await api.query("workspaceDiff", { workspaceId: "W1" })).diff.changedFiles, []);
  assert.deepEqual((await api.query("workspaceScope", { workspaceId: "W1" })).scope.violations, []);
  assert.deepEqual(calls.map((item) => item[0]), ["listRepositories", "getRepository", "workspaceStatus", "workspaceDiff", "workspaceScope"]);
});

test("Orchestrator API routes repository mutations through one command boundary", async () => {
  const { service, calls } = fakeRepositoryService();
  const api = new OrchestratorApi({ repositoryService: service });
  const cases = [
    ["openLocalRepository", { repositoryId: "repo-1", path: "/tmp/repo" }],
    ["cloneRepository", { repositoryId: "repo-2", url: "https://example.invalid/repo.git" }],
    ["setRepositoryTrust", { repositoryId: "repo-1", trust: "TRUSTED" }],
    ["createTaskWorkspace", { repositoryId: "repo-1", projectId: "P", taskId: "T", runId: "R" }],
    ["createIntegrationWorkspace", { repositoryId: "repo-1", projectId: "P", runId: "R" }],
    ["verifyWorkspace", { repositoryId: "repo-1", projectId: "P", workspaceId: "W", command: "node", args: ["--version"] }],
    ["commitWorkspace", { repositoryId: "repo-1", projectId: "P", workspaceId: "W", message: "commit" }],
    ["cleanupWorkspace", { repositoryId: "repo-1", projectId: "P", workspaceId: "W" }]
  ];

  for (const [name, payload] of cases) assert.equal((await api.execute(name, payload)).ok, true, name);
  assert.deepEqual(calls.map((item) => item[0]), cases.map((item) => item[0]));
});

test("repository API fails closed when desktop repository service is unavailable", async () => {
  const api = new OrchestratorApi({});
  assert.equal((await api.query("repositories")).reason, "repository_service_unavailable");
  assert.equal((await api.execute("openLocalRepository", {})).reason, "api_dependency_unavailable");
  assert.equal((await api.execute("verifyWorkspace", {})).reason, "api_dependency_unavailable");
});
