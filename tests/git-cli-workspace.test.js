"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const Contracts = require("../platform/contracts.js");
const { MemoryStateStore } = require("../platform/fake-runtime.js");
const { LocalRepositoryRegistry, TRUST_STATES } = require("../platform/local-repository-registry.js");
const { NodeCommandRunner } = require("../platform/node-command-runner.js");
const { GitCliWorkspace } = require("../platform/git-cli-workspace.js");

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
}

function assertSameDirectory(left, right) {
  const actual = fs.statSync(left, { bigint: true });
  const expected = fs.statSync(right, { bigint: true });
  assert.equal(actual.dev, expected.dev);
  assert.equal(actual.ino, expected.ino);
}

function createRepository(root) {
  const repository = path.join(root, "source");
  fs.mkdirSync(repository, { recursive: true });
  try {
    git(["init", "-b", "main"], repository);
  } catch {
    git(["init"], repository);
    git(["checkout", "-b", "main"], repository);
  }
  git(["config", "user.email", "orchestra-tests@example.invalid"], repository);
  git(["config", "user.name", "Orchestra Tests"], repository);
  fs.mkdirSync(path.join(repository, "src"), { recursive: true });
  fs.writeFileSync(path.join(repository, "src", "value.js"), "module.exports = 1;\n");
  fs.writeFileSync(path.join(repository, "README.md"), "# fixture\n");
  git(["add", "-A"], repository);
  git(["commit", "-m", "fixture base"], repository);
  return repository;
}

test("repository registry defaults to UNTRUSTED and persists explicit trust", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-registry-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repository = createRepository(root);
  const registry = new LocalRepositoryRegistry({ stateStore: new MemoryStateStore(), clock: () => 100 });

  const registered = await registry.registerLocal({ repositoryId: "repo-1", repositoryPath: repository });
  assert.equal(registered.trust, TRUST_STATES.UNTRUSTED);
  assert.equal(registered.mode, "local");
  assertSameDirectory(registered.path, repository);

  const trusted = await registry.setTrust("repo-1", TRUST_STATES.TRUSTED);
  assert.equal(trusted.trust, TRUST_STATES.TRUSTED);
  assert.equal((await registry.get("repo-1")).trust, TRUST_STATES.TRUSTED);
  assert.equal((await registry.list()).length, 1);
});

test("NodeCommandRunner rejects untrusted and out-of-workspace execution", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-runner-"));
  const workspaces = path.join(root, "workspaces");
  const allowed = path.join(workspaces, "project", "task");
  const outside = path.join(root, "outside");
  fs.mkdirSync(allowed, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runner = new NodeCommandRunner({ workspaceRoot: workspaces });

  await assert.rejects(
    runner.run(process.execPath, ["-e", "process.exit(0)"], allowed, { trusted: false }),
    /repository_execution_not_trusted/
  );
  await assert.rejects(
    runner.run(process.execPath, ["-e", "process.exit(0)"], outside, { trusted: true }),
    /command_cwd_outside_workspace_root/
  );
  await assert.rejects(
    runner.run(process.execPath, [], allowed, { trusted: true, shell: true }),
    /command_shell_not_allowed/
  );

  const result = await runner.run(
    process.execPath,
    ["-e", "process.stdout.write('ok')"],
    allowed,
    { trusted: true, timeoutMs: 5000, maxOutputBytes: 4096 }
  );
  assert.equal(result.ok, true);
  assert.equal(result.stdout, "ok");
});

test("GitCliWorkspace creates isolated task worktree, validates scope, verifies, commits and recovers metadata", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-git-workspace-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repository = createRepository(root);
  const workspaceRoot = path.join(root, "workspaces");
  const registry = new LocalRepositoryRegistry({ stateStore: new MemoryStateStore() });
  await registry.registerLocal({ repositoryId: "repo-1", repositoryPath: repository });
  const trustResolver = async (repositoryId) => (await registry.get(repositoryId))?.trust;

  const workspace = new GitCliWorkspace({
    projectId: "project-1",
    repositoryId: "repo-1",
    workspaceRoot,
    repositoriesRoot: path.join(root, "repositories"),
    trustResolver
  });
  Contracts.assertGitWorkspace(workspace);
  await workspace.loadRepository({ mode: "local", path: repository });
  const base = await workspace.snapshotBase();
  assert.match(base.sha, /^[0-9a-f]{40,64}$/);

  const task = await workspace.createTaskWorkspace("task-1", "run-1", base.sha);
  assert.equal(task.branch, "orchestra/project-1/task-1/run-1");
  assert.equal(fs.existsSync(task.path), true);
  assert.equal(git(["rev-parse", "HEAD"], task.path), base.sha);

  fs.writeFileSync(path.join(task.path, "src", "value.js"), "module.exports = 2;\n");
  fs.mkdirSync(path.join(task.path, "docs"), { recursive: true });
  fs.writeFileSync(path.join(task.path, "docs", "note.md"), "outside scope\n");

  const rejectedScope = await workspace.validateScope(task.workspaceId, ["src"]);
  assert.equal(rejectedScope.ok, false);
  assert.deepEqual(rejectedScope.violations, ["docs/note.md"]);
  assert.deepEqual((await workspace.status(task.workspaceId)).changedFiles, ["docs/note.md", "src/value.js"]);

  await assert.rejects(
    workspace.runVerification(task.workspaceId, { command: process.execPath, args: ["-e", "process.exit(0)"] }),
    /repository_execution_not_trusted/
  );

  await registry.setTrust("repo-1", TRUST_STATES.TRUSTED);
  const verification = await workspace.runVerification(task.workspaceId, {
    command: process.execPath,
    args: ["-e", "const v=require('./src/value.js'); if(v!==2) process.exit(7); process.stdout.write('verified')"],
    timeoutMs: 5000
  });
  assert.equal(verification.ok, true);
  assert.equal(verification.stdout, "verified");

  const acceptedScope = await workspace.validateScope(task.workspaceId, ["src", "docs"]);
  assert.equal(acceptedScope.ok, true);
  const committed = await workspace.commit(task.workspaceId, "task change");
  assert.equal(committed.ok, true);
  assert.notEqual(committed.head, base.sha);
  assert.equal((await workspace.status(task.workspaceId)).clean, true);

  const recovered = new GitCliWorkspace({
    projectId: "project-1",
    repositoryId: "repo-1",
    workspaceRoot,
    repositoriesRoot: path.join(root, "repositories"),
    trustResolver
  });
  await recovered.loadRepository(repository);
  const recoveredStatus = await recovered.status(task.workspaceId);
  assert.equal(recoveredStatus.head, committed.head);
  assert.equal(recoveredStatus.clean, true);

  const cleanup = await recovered.cleanup(task.workspaceId, { deleteBranch: true });
  assert.equal(cleanup.ok, true);
  assert.equal(fs.existsSync(task.path), false);
  assert.equal(git(["branch", "--list", task.branch], repository), "");
});

test("GitCliWorkspace clone mode is confined to repositoriesRoot and integration worktrees are isolated", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-git-clone-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = createRepository(root);
  const workspaceRoot = path.join(root, "workspaces");
  const repositoriesRoot = path.join(root, "repositories");
  const target = path.join(repositoriesRoot, "repo-clone");
  const workspace = new GitCliWorkspace({
    projectId: "project-clone",
    repositoryId: "repo-clone",
    workspaceRoot,
    repositoriesRoot
  });

  const loaded = await workspace.loadRepository({ mode: "clone", sourceUrl: source, path: target });
  assert.equal(loaded.mode, "clone");
  assertSameDirectory(loaded.path, target);
  const base = await workspace.snapshotBase();
  const integration = await workspace.createIntegrationWorkspace("integration-1", base.sha);
  assert.equal(integration.branch, "orchestra/project-clone/integration/integration-1");
  assert.equal(fs.existsSync(integration.path), true);
  await workspace.cleanup(integration.workspaceId, { deleteBranch: true });

  const escaped = new GitCliWorkspace({
    projectId: "project-escape",
    repositoryId: "repo-escape",
    workspaceRoot: path.join(root, "other-workspaces"),
    repositoriesRoot
  });
  await assert.rejects(
    escaped.loadRepository({ mode: "clone", sourceUrl: source, path: path.join(root, "escape") }),
    /git_clone_target_outside_repositories_root/
  );
});
