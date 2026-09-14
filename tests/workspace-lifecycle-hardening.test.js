"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { WorkspaceLifecyclePolicy } = require("../apps/desktop/main/workspace-lifecycle.js");
const { DesktopRepositoryService } = require("../apps/desktop/main/repository-service.js");
const { DesktopHost } = require("../apps/desktop/main/desktop-host.js");

function record(workspaceId, createdAt, kind = "task") {
  return { workspaceId, createdAt, kind, taskId: kind === "task" ? "T1" : null, runId: workspaceId, branch: `orchestra/P1/${workspaceId}`, startSha: "a".repeat(40), path: `/fake/${workspaceId}` };
}

test("abandoned workspace cleanup removes only clean stale worktrees and preserves dirty salvage", async () => {
  const now = 10_000;
  const statuses = new Map([
    ["active", { clean: true, head: "1".repeat(40), changedFiles: [] }],
    ["old-clean", { clean: true, head: "2".repeat(40), changedFiles: [] }],
    ["old-dirty", { clean: false, head: "3".repeat(40), changedFiles: ["src/wip.js"] }],
    ["fresh-clean", { clean: true, head: "4".repeat(40), changedFiles: [] }]
  ]);
  const cleaned = [];
  const adapter = {
    workspaces: new Map([
      ["active", record("active", 1_000)],
      ["old-clean", record("old-clean", 1_000)],
      ["old-dirty", record("old-dirty", 1_000)],
      ["fresh-clean", record("fresh-clean", 9_900)],
      ["missing", record("missing", 1_000)]
    ]),
    async status(id) {
      if (id === "missing") throw new Error("git_workspace_missing");
      return { workspaceId: id, ...statuses.get(id) };
    },
    async cleanup(id, options) {
      assert.deepEqual(options, { force: false, deleteBranch: true });
      cleaned.push(id);
      return true;
    }
  };
  const policy = new WorkspaceLifecyclePolicy({ clock: () => now });
  const report = await policy.scan(adapter, { activeWorkspaceIds: ["active"], retentionMs: 1_000 });
  assert.equal(report.items.find((item) => item.workspaceId === "active").classification, "active");
  assert.equal(report.items.find((item) => item.workspaceId === "old-clean").classification, "cleanup-eligible");
  assert.equal(report.items.find((item) => item.workspaceId === "old-dirty").classification, "salvage");
  assert.equal(report.items.find((item) => item.workspaceId === "fresh-clean").classification, "retained");
  assert.equal(report.items.find((item) => item.workspaceId === "missing").classification, "missing");

  const result = await policy.cleanup(adapter, { activeWorkspaceIds: ["active"], retentionMs: 1_000 });
  assert.deepEqual(cleaned, ["old-clean"]);
  assert.deepEqual(result.salvage.map((item) => item.workspaceId), ["old-dirty"]);
});

test("repository verification audit stores metadata only, never argv or command output", async () => {
  const audit = [];
  const adapter = {
    async loadRepository() {},
    async runVerification() {
      return { ok: true, status: "passed", exitCode: 0, stdout: "SECRET_OUTPUT", stderr: "", startedAt: 10, finishedAt: 20, stdoutTruncated: false, stderrTruncated: false };
    }
  };
  const service = new DesktopRepositoryService({
    stateStore: { async get() { return {}; }, async set() {} },
    paths: { repositoriesDirectory: path.resolve("/tmp/repos"), workspacesDirectory: path.resolve("/tmp/workspaces") },
    workspaceFactory: () => adapter,
    logger: { info(event, details) { audit.push({ event, details }); } },
    clock: () => 30
  });
  service.registry.get = async () => ({ repositoryId: "repo-1", path: "/tmp/repo", trust: "TRUSTED" });
  service.adapters.set(service.adapterKey("P1", "repo-1"), adapter);

  const result = await service.verifyWorkspace({
    projectId: "P1",
    repositoryId: "repo-1",
    workspaceId: "task:T1:R1",
    runId: "verify:R1",
    command: "node",
    args: ["--eval", "TOP_SECRET_ARG"],
    timeoutMs: 5_000
  });
  assert.equal(result.ok, true);
  const serializedAudit = JSON.stringify(audit);
  assert.equal(serializedAudit.includes("TOP_SECRET_ARG"), false);
  assert.equal(serializedAudit.includes("SECRET_OUTPUT"), false);
  assert.match(serializedAudit, /\"argCount\":2/);
  assert.match(serializedAudit, /verification_finished/);
});

test("desktop Worker dispatch prepares the run worktree before sending the prompt", async () => {
  const order = [];
  const fakeHost = {
    agentRuntime: {
      getAgent() { return { agentId: "A1", protocolContext: { projectId: "P1", taskId: "T1", runId: "R1" } }; },
      async sendPrompt(agentId, prompt) { order.push(["send", agentId, prompt]); return { ok: true }; }
    },
    schedulerStore: {
      getRun() { return { runId: "R1", taskId: "T1", git: { required: true, startSha: "a".repeat(40) } }; },
      getTask() { return { id: "T1", definition: { id: "T1", kind: "code" } }; },
      getGitSnapshot() { return { baseSha: "a".repeat(40) }; },
      async logDecision(type, details) { order.push(["decision", type, details.workspaceId]); }
    },
    projectStore: { getActiveProject() { return { projectId: "P1", repositoryRuntime: { repositoryId: "repo-1" } }; } },
    gitProvider: {
      async prepareRun(input) { order.push(["prepare", input.run.runId]); return { ok: true, workspaceId: "task:T1:R1", created: true }; }
    }
  };

  const result = await DesktopHost.prototype.sendWorkerPromptWithWorkspace.call(fakeHost, "A1", "do work");
  assert.equal(result.ok, true);
  assert.deepEqual(order.map((item) => item[0]), ["prepare", "decision", "send"]);
});

test("desktop Worker dispatch fails closed before prompt when worktree preparation fails", async () => {
  let sent = false;
  const fakeHost = {
    agentRuntime: {
      getAgent() { return { agentId: "A1", protocolContext: { projectId: "P1", taskId: "T1", runId: "R1" } }; },
      async sendPrompt() { sent = true; return { ok: true }; }
    },
    schedulerStore: {
      getRun() { return { runId: "R1", taskId: "T1", git: { required: true } }; },
      getTask() { return { id: "T1", definition: { id: "T1" } }; },
      getGitSnapshot() { return { baseSha: "a".repeat(40) }; }
    },
    projectStore: { getActiveProject() { return { projectId: "P1", repositoryRuntime: { repositoryId: "repo-1" } }; } },
    gitProvider: { async prepareRun() { return { ok: false, reason: "local_workspace_create_failed" }; } }
  };
  const result = await DesktopHost.prototype.sendWorkerPromptWithWorkspace.call(fakeHost, "A1", "do work");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "local_workspace_prepare_failed");
  assert.equal(sent, false);
});
