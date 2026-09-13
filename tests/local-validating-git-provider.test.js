"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { LocalValidatingGitProvider } = require("../apps/desktop/main/local-validating-git-provider.js");

const BASE = "a".repeat(40);
const COMMIT = "b".repeat(40);

function remoteProvider() {
  return {
    branchName(projectId, taskId, runId) { return `orchestra/${projectId}/${taskId}/${runId}`; },
    async captureBase() { return { ok: true, snapshot: { baseSha: BASE } }; },
    async checkBaseFresh() { return { ok: true, currentTargetSha: BASE }; },
    async validateArtifact({ run }) {
      return {
        ok: true,
        artifact: { branch: run.git.branch, commit: COMMIT, changedFiles: ["worker-reported.txt"] },
        freshness: { ok: true, currentTargetSha: BASE }
      };
    }
  };
}

function input({ bound = true } = {}) {
  return {
    project: { projectId: "P1", repositoryRuntime: bound ? { repositoryId: "repo-1" } : null },
    task: { id: "T1", scope: { allow: ["src"] } },
    run: { runId: "R1", git: { branch: "orchestra/P1/T1/R1", startSha: BASE, baseSha: BASE } },
    snapshot: { baseSha: BASE },
    payload: {}
  };
}

test("local validating provider replaces changed-file provenance with local startSha..artifactSha evidence", async () => {
  const calls = [];
  const repositoryService = {
    async createTaskWorkspace(payload) { calls.push(["create", payload]); return { ok: true, workspace: { workspaceId: "task:T1:R1" } }; },
    async materializeTaskArtifact(payload) { calls.push(["materialize", payload]); return { ok: true, artifact: { head: COMMIT, changedFiles: ["src/real.js"], clean: true } }; },
    async workspaceScope(payload) { calls.push(["scope", payload]); return { ok: true, scope: { ok: true, violations: [], artifactChangedFiles: ["src/real.js"] } }; }
  };
  const provider = new LocalValidatingGitProvider({ remoteProvider: remoteProvider(), repositoryService, logger: { warn() {} } });
  const result = await provider.validateArtifact(input());

  assert.equal(result.ok, true);
  assert.deepEqual(result.artifact.remoteChangedFiles, ["worker-reported.txt"]);
  assert.deepEqual(result.artifact.changedFiles, ["src/real.js"]);
  assert.equal(result.artifact.workspaceId, "task:T1:R1");
  assert.equal(result.artifact.repositoryId, "repo-1");
  assert.deepEqual(calls.map((item) => item[0]), ["create", "materialize", "scope"]);
});

test("local scope violation blocks worker artifact before Review", async () => {
  const repositoryService = {
    async createTaskWorkspace() { return { ok: true, workspace: { workspaceId: "task:T1:R1" } }; },
    async materializeTaskArtifact() { return { ok: true, artifact: { head: COMMIT, changedFiles: ["secrets.txt"], clean: true } }; },
    async workspaceScope() { return { ok: true, scope: { ok: false, violations: ["secrets.txt"] } }; }
  };
  const provider = new LocalValidatingGitProvider({ remoteProvider: remoteProvider(), repositoryService, logger: { warn() {} } });
  const result = await provider.validateArtifact(input());
  assert.equal(result.ok, false);
  assert.equal(result.reason, "local_scope_violation");
  assert.deepEqual(result.local.scope.violations, ["secrets.txt"]);
});

test("legacy project without local repository binding keeps existing remote provenance path", async () => {
  const provider = new LocalValidatingGitProvider({
    remoteProvider: remoteProvider(),
    repositoryService: { async createTaskWorkspace() { throw new Error("must_not_run"); } },
    logger: { warn() {} }
  });
  const result = await provider.validateArtifact(input({ bound: false }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.artifact.changedFiles, ["worker-reported.txt"]);
  assert.equal(result.local, undefined);
});
