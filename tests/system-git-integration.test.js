"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { SystemGitWorkspace } = require("../platform/system-git-workspace.js");
const { TRUST_STATES } = require("../platform/local-repository-registry.js");

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
}

function fixtureRepository(root) {
  const repository = path.join(root, "repo");
  fs.mkdirSync(repository, { recursive: true });
  try { git(["init", "-b", "main"], repository); }
  catch { git(["init"], repository); git(["checkout", "-b", "main"], repository); }
  git(["config", "user.email", "orchestra-tests@example.invalid"], repository);
  git(["config", "user.name", "Orchestra Tests"], repository);
  fs.mkdirSync(path.join(repository, "src"), { recursive: true });
  fs.writeFileSync(path.join(repository, "src", "base.txt"), "base\n");
  fs.writeFileSync(path.join(repository, "src", "shared.txt"), "base\n");
  git(["add", "-A"], repository);
  git(["commit", "-m", "base"], repository);
  return repository;
}

function makeWorkspace(root, repository, projectId = "P1") {
  return new SystemGitWorkspace({
    projectId,
    repositoryId: `repo-${projectId}`,
    workspaceRoot: path.join(root, "workspaces"),
    trustResolver: async () => TRUST_STATES.TRUSTED
  });
}

test("integration workspace creates deterministic no-ff merge and never duplicates it", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-integration-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repository = fixtureRepository(root);
  const workspace = makeWorkspace(root, repository);
  await workspace.loadRepository({ mode: "local", path: repository });
  const base = await workspace.snapshotBase();

  const task = await workspace.createTaskWorkspace({ projectId: "P1", taskId: "T1", runId: "R1", startSha: base.baseSha });
  fs.writeFileSync(path.join(task.path, "src", "task.txt"), "task\n");
  const taskCommit = await workspace.commit(task.workspaceId, { message: "task artifact" });
  assert.equal(taskCommit.ok, true);

  const integration = await workspace.createIntegrationWorkspace({ projectId: "P1", runId: "I1", startSha: base.baseSha });
  const merged = await workspace.mergeTaskArtifact(integration.workspaceId, taskCommit.sha);
  assert.equal(merged.ok, true);
  assert.equal(merged.alreadyIntegrated, false);
  assert.equal(merged.parents.length, 2);
  assert.equal(merged.parents[0], base.baseSha);
  assert.equal(merged.parents[1], taskCommit.sha);
  assert.equal((await workspace.status(integration.workspaceId)).clean, true);

  const duplicate = await workspace.mergeTaskArtifact(integration.workspaceId, taskCommit.sha);
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.alreadyIntegrated, true);
  assert.equal(duplicate.head, merged.head);

  assert.equal(await workspace.cleanup(task.workspaceId, { deleteBranch: true }), true);
  assert.equal(await workspace.cleanup(integration.workspaceId, { deleteBranch: true }), true);
});

test("text merge conflict is reported with files and the integration workspace is cleanly aborted", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-integration-conflict-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repository = fixtureRepository(root);
  const workspace = makeWorkspace(root, repository, "P-conflict");
  await workspace.loadRepository({ mode: "local", path: repository });
  const base = await workspace.snapshotBase();

  const task1 = await workspace.createTaskWorkspace({ projectId: "P-conflict", taskId: "T1", runId: "R1", startSha: base.baseSha });
  fs.writeFileSync(path.join(task1.path, "src", "shared.txt"), "from-task-1\n");
  const commit1 = await workspace.commit(task1.workspaceId, { message: "task 1" });

  const task2 = await workspace.createTaskWorkspace({ projectId: "P-conflict", taskId: "T2", runId: "R2", startSha: base.baseSha });
  fs.writeFileSync(path.join(task2.path, "src", "shared.txt"), "from-task-2\n");
  const commit2 = await workspace.commit(task2.workspaceId, { message: "task 2" });

  const integration = await workspace.createIntegrationWorkspace({ projectId: "P-conflict", runId: "I1", startSha: base.baseSha });
  assert.equal((await workspace.mergeTaskArtifact(integration.workspaceId, commit1.sha)).ok, true);
  const conflict = await workspace.mergeTaskArtifact(integration.workspaceId, commit2.sha);
  assert.equal(conflict.ok, false);
  assert.equal(conflict.reason, "git_merge_conflict");
  assert.deepEqual(conflict.files, ["src/shared.txt"]);
  const after = await workspace.status(integration.workspaceId);
  assert.equal(after.clean, true);
  assert.equal(git(["rev-parse", "HEAD"], integration.path), commit1.sha === base.baseSha ? base.baseSha : after.head);

  await workspace.cleanup(task1.workspaceId, { deleteBranch: true });
  await workspace.cleanup(task2.workspaceId, { deleteBranch: true });
  await workspace.cleanup(integration.workspaceId, { deleteBranch: true });
});

test("push is limited to validated clean Orchestra branches", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-push-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repository = fixtureRepository(root);
  const remote = path.join(root, "remote.git");
  fs.mkdirSync(remote, { recursive: true });
  git(["init", "--bare"], remote);
  git(["remote", "add", "test-remote", remote], repository);

  const workspace = new SystemGitWorkspace({
    projectId: "P2",
    repositoryId: "repo-2",
    workspaceRoot: path.join(root, "workspaces"),
    trustResolver: async () => TRUST_STATES.TRUSTED
  });
  await workspace.loadRepository({ mode: "local", path: repository });
  const base = await workspace.snapshotBase();
  const task = await workspace.createTaskWorkspace({ projectId: "P2", taskId: "T2", runId: "R2", startSha: base.baseSha });
  fs.writeFileSync(path.join(task.path, "src", "push.txt"), "push\n");
  const committed = await workspace.commit(task.workspaceId, { message: "push candidate" });

  await assert.rejects(workspace.push(task.workspaceId, { remote: "test-remote" }), /git_push_requires_local_validation/);
  await assert.rejects(
    workspace.push(task.workspaceId, { remote: "test-remote", validated: true, branch: "main" }),
    /git_push_branch_not_allowed/
  );

  const pushed = await workspace.push(task.workspaceId, { remote: "test-remote", validated: true });
  assert.equal(pushed.ok, true);
  assert.equal(git(["rev-parse", `refs/heads/${task.branch}`], remote), committed.sha);
  assert.equal(await workspace.cleanup(task.workspaceId, { deleteBranch: true }), true);
});
