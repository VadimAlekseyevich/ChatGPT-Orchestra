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

function configure(repository) {
  git(["config", "user.email", "orchestra-tests@example.invalid"], repository);
  git(["config", "user.name", "Orchestra Tests"], repository);
}

test("validated remote task commit is fetched into its worktree and provenance is recomputed locally", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-materialize-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const remote = path.join(root, "remote.git");
  fs.mkdirSync(remote, { recursive: true });
  git(["init", "--bare"], remote);

  const producer = path.join(root, "producer");
  fs.mkdirSync(producer, { recursive: true });
  try { git(["init", "-b", "main"], producer); }
  catch { git(["init"], producer); git(["checkout", "-b", "main"], producer); }
  configure(producer);
  fs.mkdirSync(path.join(producer, "src"), { recursive: true });
  fs.writeFileSync(path.join(producer, "src", "base.txt"), "base\n");
  git(["add", "-A"], producer);
  git(["commit", "-m", "base"], producer);
  const baseSha = git(["rev-parse", "HEAD"], producer);
  git(["remote", "add", "origin", remote], producer);
  git(["push", "-u", "origin", "main"], producer);
  git(["symbolic-ref", "HEAD", "refs/heads/main"], remote);

  const consumer = path.join(root, "consumer");
  git(["clone", "-b", "main", remote, consumer], root);
  configure(consumer);

  const branch = "orchestra/P1/T1/R1";
  git(["checkout", "-b", branch, baseSha], producer);
  fs.writeFileSync(path.join(producer, "src", "task.txt"), "artifact\n");
  git(["add", "-A"], producer);
  git(["commit", "-m", "worker artifact"], producer);
  const taskCommit = git(["rev-parse", "HEAD"], producer);
  git(["push", "origin", `${branch}:${branch}`], producer);

  assert.throws(() => git(["cat-file", "-e", `${taskCommit}^{commit}`], consumer));

  const workspace = new SystemGitWorkspace({
    projectId: "P1",
    repositoryId: "repo-1",
    workspaceRoot: path.join(root, "workspaces"),
    trustResolver: async () => TRUST_STATES.TRUSTED
  });
  await workspace.loadRepository({ mode: "local", path: consumer });
  const task = await workspace.createTaskWorkspace({ projectId: "P1", taskId: "T1", runId: "R1", startSha: baseSha });

  const materialized = await workspace.materializeTaskArtifact(task.workspaceId, {
    commit: taskCommit,
    branch,
    remote: "origin"
  });
  assert.equal(materialized.ok, true);
  assert.equal(materialized.head, taskCommit);
  assert.equal(materialized.clean, true);
  assert.deepEqual(materialized.changedFiles, ["src/task.txt"]);

  const localArtifact = await workspace.artifactState(task.workspaceId);
  assert.deepEqual(localArtifact.changedFiles, ["src/task.txt"]);
  assert.equal((await workspace.validateScope(task.workspaceId, { allow: ["src"] })).ok, true);
  const rejected = await workspace.validateScope(task.workspaceId, { allow: ["docs"] });
  assert.equal(rejected.ok, false);
  assert.deepEqual(rejected.artifactViolations, ["src/task.txt"]);

  assert.equal(await workspace.cleanup(task.workspaceId, { deleteBranch: true }), true);
});
