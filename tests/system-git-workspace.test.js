"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const Contracts = require("../platform/contracts.js");
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
  fs.writeFileSync(path.join(repository, "src", "index.js"), "module.exports = 1;\n");
  git(["add", "-A"], repository);
  git(["commit", "-m", "base"], repository);
  return repository;
}

test("SystemGitWorkspace exposes the established GitWorkspace DTO contract", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-system-git-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repository = fixtureRepository(root);
  const workspace = new SystemGitWorkspace({
    projectId: "P1",
    repositoryId: "repo-1",
    workspaceRoot: path.join(root, "workspaces"),
    repositoriesRoot: path.join(root, "repositories"),
    trustResolver: async () => TRUST_STATES.TRUSTED
  });

  Contracts.assertGitWorkspace(workspace);
  const loaded = await workspace.loadRepository({ mode: "local", path: repository });
  assert.equal(loaded.ok, true);
  assert.equal(fs.realpathSync(loaded.repository.path), fs.realpathSync(repository));

  const base = await workspace.snapshotBase();
  assert.equal(base.ok, true);
  assert.match(base.baseSha, /^[0-9a-f]{40,64}$/i);
  assert.equal(base.targetBranch, "main");

  const task = await workspace.createTaskWorkspace({ projectId: "P1", taskId: "T1", runId: "R1", startSha: base.baseSha });
  fs.writeFileSync(path.join(task.path, "src", "index.js"), "module.exports = 2;\n");

  assert.equal((await workspace.status(task.workspaceId)).ok, true);
  assert.equal((await workspace.diff(task.workspaceId)).ok, true);
  assert.equal((await workspace.validateScope(task.workspaceId, { allow: ["src"] })).ok, true);
  const verification = await workspace.runVerification(task.workspaceId, {
    command: process.execPath,
    args: ["-e", "if(require('./src/index.js')!==2) process.exit(9)"]
  });
  assert.equal(verification.ok, true);

  const commit = await workspace.commit(task.workspaceId, { message: "contract commit" });
  assert.equal(commit.ok, true);
  assert.equal(commit.sha, commit.head);
  assert.equal(await workspace.cleanup(task.workspaceId, { deleteBranch: true }), true);
});

test("SystemGitWorkspace refuses shell-string verification commands", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-system-git-safe-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repository = fixtureRepository(root);
  const workspace = new SystemGitWorkspace({
    projectId: "P2",
    repositoryId: "repo-2",
    workspaceRoot: path.join(root, "workspaces"),
    trustResolver: async () => TRUST_STATES.TRUSTED
  });
  await workspace.loadRepository({ mode: "local", path: repository });
  const base = await workspace.snapshotBase();
  const task = await workspace.createTaskWorkspace({ projectId: "P2", taskId: "T2", runId: "R2", startSha: base.baseSha });
  await assert.rejects(workspace.runVerification(task.workspaceId, ["npm test"]), /verification_command_requires_argv/);
  assert.equal(await workspace.cleanup(task.workspaceId, { deleteBranch: true }), true);
});
