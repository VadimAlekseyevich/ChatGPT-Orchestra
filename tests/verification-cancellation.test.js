"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { DesktopRepositoryService } = require("../apps/desktop/main/repository-service.js");

function serviceFixture() {
  let finish = null;
  let markStarted = null;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const audit = [];
  const adapter = {
    runVerification(workspaceId, verification) {
      assert.equal(workspaceId, "task:T1:R1");
      assert.equal(verification.runId, "verify:R1");
      markStarted?.();
      return new Promise((resolve) => { finish = resolve; });
    },
    cancelVerification(runId) {
      assert.equal(runId, "verify:R1");
      finish?.({
        runId,
        ok: false,
        status: "cancelled",
        exitCode: null,
        signal: "SIGTERM",
        stdout: "",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        startedAt: 10,
        finishedAt: 20
      });
      return true;
    }
  };
  const service = new DesktopRepositoryService({
    stateStore: { async get() { return {}; }, async set() {} },
    paths: { repositoriesDirectory: path.resolve("/tmp/repos"), workspacesDirectory: path.resolve("/tmp/workspaces") },
    workspaceFactory: () => adapter,
    logger: { info(event, details) { audit.push({ event, details }); } },
    clock: (() => { let now = 100; return () => ++now; })()
  });
  service.registry.get = async () => ({ repositoryId: "repo-1", path: "/tmp/repo", trust: "TRUSTED" });
  service.adapters.set(service.adapterKey("P1", "repo-1"), adapter);
  return { service, audit, started };
}

test("active local verification is observable by metadata and cancellable by runId", async () => {
  const { service, audit, started } = serviceFixture();
  const pending = service.verifyWorkspace({
    projectId: "P1",
    repositoryId: "repo-1",
    workspaceId: "task:T1:R1",
    runId: "verify:R1",
    command: "node",
    args: ["--eval", "DO_NOT_EXPOSE_THIS_ARG"],
    timeoutMs: 5000
  });

  await started;
  const active = service.listActiveVerificationRuns({ projectId: "P1", repositoryId: "repo-1" });
  assert.equal(active.ok, true);
  assert.equal(active.runs.length, 1);
  assert.deepEqual(active.runs[0], {
    projectId: "P1",
    repositoryId: "repo-1",
    workspaceId: "task:T1:R1",
    runId: "verify:R1",
    command: "node",
    argCount: 2,
    timeoutMs: 5000,
    startedAt: 101
  });
  assert.equal(JSON.stringify(active).includes("DO_NOT_EXPOSE_THIS_ARG"), false);

  const cancelled = await service.cancelVerification({ projectId: "P1", repositoryId: "repo-1", runId: "verify:R1" });
  assert.equal(cancelled.ok, true);
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.verification.status, "cancelled");
  assert.equal(service.listActiveVerificationRuns().runs.length, 0);

  const serializedAudit = JSON.stringify(audit);
  assert.equal(serializedAudit.includes("DO_NOT_EXPOSE_THIS_ARG"), false);
  assert.match(serializedAudit, /verification_cancel_requested/);
  assert.match(serializedAudit, /\"argCount\":2/);
});

test("verification cancellation rejects stale and mismatched run identities", async () => {
  const { service, started } = serviceFixture();
  assert.deepEqual(await service.cancelVerification({ runId: "missing" }), { ok: false, reason: "verification_run_not_active", runId: "missing" });

  const pending = service.verifyWorkspace({
    projectId: "P1",
    repositoryId: "repo-1",
    workspaceId: "task:T1:R1",
    runId: "verify:R1",
    command: "node",
    args: []
  });
  await started;
  assert.equal((await service.cancelVerification({ projectId: "P2", runId: "verify:R1" })).reason, "verification_run_project_mismatch");
  assert.equal((await service.cancelVerification({ repositoryId: "repo-2", runId: "verify:R1" })).reason, "verification_run_repository_mismatch");
  await service.cancelVerification({ runId: "verify:R1" });
  await pending;
});
