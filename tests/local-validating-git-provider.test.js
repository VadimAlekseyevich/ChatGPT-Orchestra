"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { LocalValidatingGitProvider } = require("../apps/desktop/main/local-validating-git-provider.js");

const BASE = "a".repeat(40);
const COMMIT = "b".repeat(40);

function remoteProvider(calls = []) {
  return {
    branchName(projectId, taskId, runId) { return `orchestra/${projectId}/${taskId}/${runId}`; },
    async request(path) { calls.push(["request", path]); return { ok: true, data: { path } }; },
    async getRepository(project) { calls.push(["getRepository", project?.projectId]); return { ok: true, repository: { id: 1 } }; },
    async getBranchHead(project, branch) { calls.push(["getBranchHead", project?.projectId, branch]); return { ok: true, branch, sha: COMMIT }; },
    async compare(project, base, head) { calls.push(["compare", project?.projectId, base, head]); return { ok: true, comparison: { base, head } }; },
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

function input({ bound = true, localVerification = [{ command: "node", args: ["--version"], label: "node" }], verificationWaiver = "" } = {}) {
  return {
    project: { projectId: "P1", repositoryRuntime: bound ? { repositoryId: "repo-1" } : null },
    task: { id: "T1", kind: "code", scope: { allow: ["src"] }, localVerification, verificationWaiver },
    run: { runId: "R1", git: { branch: "orchestra/P1/T1/R1", startSha: BASE, baseSha: BASE } },
    snapshot: { baseSha: BASE },
    payload: {}
  };
}

test("local validating provider preserves the remote Git provider surface used by integration", async () => {
  const calls = [];
  const provider = new LocalValidatingGitProvider({ remoteProvider: remoteProvider(calls), repositoryService: {}, logger: { warn() {} } });
  const project = { projectId: "P1" };
  assert.equal((await provider.request("/x")).ok, true);
  assert.equal((await provider.getRepository(project)).ok, true);
  assert.equal((await provider.getBranchHead(project, "main")).sha, COMMIT);
  assert.equal((await provider.compare(project, BASE, COMMIT)).ok, true);
  assert.deepEqual(calls.map((item) => item[0]), ["request", "getRepository", "getBranchHead", "compare"]);
});

test("local validating provider replaces provenance and runs structured verification before Review", async () => {
  const calls = [];
  const repositoryService = {
    async createTaskWorkspace(payload) { calls.push(["create", payload]); return { ok: true, workspace: { workspaceId: "task:T1:R1" } }; },
    async materializeTaskArtifact(payload) { calls.push(["materialize", payload]); return { ok: true, artifact: { head: COMMIT, changedFiles: ["src/real.js"], clean: true } }; },
    async workspaceScope(payload) { calls.push(["scope", payload]); return { ok: true, scope: { ok: true, violations: [], artifactChangedFiles: ["src/real.js"] } }; },
    async verifyWorkspace(payload) { calls.push(["verify", payload]); return { ok: true, verification: { ok: true, status: "passed", stdout: "ok", stderr: "" } }; }
  };
  const provider = new LocalValidatingGitProvider({ remoteProvider: remoteProvider(), repositoryService, logger: { warn() {} } });
  const result = await provider.validateArtifact(input());

  assert.equal(result.ok, true);
  assert.deepEqual(result.artifact.remoteChangedFiles, ["worker-reported.txt"]);
  assert.deepEqual(result.artifact.changedFiles, ["src/real.js"]);
  assert.equal(result.artifact.workspaceId, "task:T1:R1");
  assert.equal(result.artifact.repositoryId, "repo-1");
  assert.equal(result.artifact.localVerificationPassed, true);
  assert.equal(result.local.verification[0].result.status, "passed");
  assert.deepEqual(calls.map((item) => item[0]), ["create", "materialize", "scope", "verify"]);
  assert.deepEqual(calls.at(-1)[1].args, ["--version"]);
});

test("local verification failure blocks artifact before Review and remains retryable", async () => {
  const repositoryService = {
    async createTaskWorkspace() { return { ok: true, workspace: { workspaceId: "task:T1:R1" } }; },
    async materializeTaskArtifact() { return { ok: true, artifact: { head: COMMIT, changedFiles: ["src/real.js"], clean: true } }; },
    async workspaceScope() { return { ok: true, scope: { ok: true, violations: [] } }; },
    async verifyWorkspace() { return { ok: false, verification: { ok: false, status: "failed", exitCode: 7, stdout: "", stderr: "test failed" } }; }
  };
  const provider = new LocalValidatingGitProvider({ remoteProvider: remoteProvider(), repositoryService, logger: { warn() {} } });
  const result = await provider.validateArtifact(input());
  assert.equal(result.ok, false);
  assert.equal(result.reason, "local_verification_failed");
  assert.equal(result.local.verification[0].result.exitCode, 7);
});

test("untrusted repository blocks command execution before Review", async () => {
  const repositoryService = {
    async createTaskWorkspace() { return { ok: true, workspace: { workspaceId: "task:T1:R1" } }; },
    async materializeTaskArtifact() { return { ok: true, artifact: { head: COMMIT, changedFiles: ["src/real.js"], clean: true } }; },
    async workspaceScope() { return { ok: true, scope: { ok: true, violations: [] } }; },
    async verifyWorkspace() { throw new Error("repository_execution_not_trusted"); }
  };
  const provider = new LocalValidatingGitProvider({ remoteProvider: remoteProvider(), repositoryService, logger: { warn() {} } });
  const result = await provider.validateArtifact(input());
  assert.equal(result.ok, false);
  assert.equal(result.reason, "repository_execution_not_trusted");
});

test("missing structured verification plan fails closed for local code tasks", async () => {
  const provider = new LocalValidatingGitProvider({ remoteProvider: remoteProvider(), repositoryService: {}, logger: { warn() {} } });
  const result = await provider.validateArtifact(input({ localVerification: undefined }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, "local_verification_plan_missing");
});

test("verification waiver permits local scope validation without command execution", async () => {
  const calls = [];
  const repositoryService = {
    async createTaskWorkspace() { calls.push("create"); return { ok: true, workspace: { workspaceId: "task:T1:R1" } }; },
    async materializeTaskArtifact() { calls.push("materialize"); return { ok: true, artifact: { head: COMMIT, changedFiles: ["src/real.js"], clean: true } }; },
    async workspaceScope() { calls.push("scope"); return { ok: true, scope: { ok: true, violations: [] } }; },
    async verifyWorkspace() { calls.push("verify"); throw new Error("must_not_run"); }
  };
  const provider = new LocalValidatingGitProvider({ remoteProvider: remoteProvider(), repositoryService, logger: { warn() {} } });
  const result = await provider.validateArtifact(input({ localVerification: undefined, verificationWaiver: "No executable test exists for this docs-only code fixture." }));
  assert.equal(result.ok, true);
  assert.equal(result.local.verificationWaived, true);
  assert.deepEqual(calls, ["create", "materialize", "scope"]);
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
  const result = await provider.validateArtifact(input({ bound: false, localVerification: undefined }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.artifact.changedFiles, ["worker-reported.txt"]);
  assert.equal(result.local, undefined);
});
