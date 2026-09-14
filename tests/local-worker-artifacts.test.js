"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { GitCliWorkspace } = require("../platform/git-cli-workspace.js");
const { normalizeLocalChangeSet, MAX_LOCAL_CHANGE_BYTES } = require("../platform/local-change-set.js");
const { evaluateScope } = require("../platform/workspace-scope-policy.js");
const { TRUST_STATES } = require("../platform/local-repository-registry.js");
const { LocalValidatingGitProvider } = require("../apps/desktop/main/local-validating-git-provider.js");
const { createLocalReviewEngine } = require("../apps/desktop/main/local-review-engine.js");
const WorkerPrompts = require("../prompts/worker-prompts.js");

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
  fs.writeFileSync(path.join(repository, "src", "value.js"), "module.exports = 1;\n");
  fs.writeFileSync(path.join(repository, "src", "obsolete.js"), "module.exports = 'old';\n");
  git(["add", "-A"], repository);
  git(["commit", "-m", "base"], repository);
  return repository;
}

test("file-set-v1 rejects traversal and oversized content before filesystem application", () => {
  assert.equal(normalizeLocalChangeSet({ format: "file-set-v1", files: [{ path: "../escape", operation: "write", content: "x" }] }).ok, false);
  const oversized = "x".repeat(MAX_LOCAL_CHANGE_BYTES + 1);
  const result = normalizeLocalChangeSet({ format: "file-set-v1", files: [{ path: "src/large.txt", operation: "write", content: oversized }] });
  assert.equal(result.ok, false);
  assert.ok(["local_change_file_too_large", "local_change_set_too_large"].includes(result.reason));
});

test("scope policy supports globs and deny rules before change application", () => {
  const allowed = evaluateScope(["src/value.js", "src/nested/new.js"], { allow: ["src/**"], deny: ["src/generated/**"] });
  assert.equal(allowed.ok, true);
  const denied = evaluateScope(["src/value.js", "src/generated/client.js"], { allow: ["src/**"], deny: ["src/generated/**"] });
  assert.equal(denied.ok, false);
  assert.deepEqual(denied.denied, ["src/generated/client.js"]);
  assert.deepEqual(denied.violations, ["src/generated/client.js"]);
});

test("local worker artifact executes worktree -> changes -> scope -> tests -> commit -> review diff without push", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-local-worker-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repository = fixtureRepository(root);
  const workspace = new GitCliWorkspace({ projectId: "P1", repositoryId: "repo-1", workspaceRoot: path.join(root, "workspaces"), trustResolver: async () => TRUST_STATES.TRUSTED });
  await workspace.loadRepository({ mode: "local", path: repository });
  const base = await workspace.snapshotBase();
  const task = await workspace.createTaskWorkspace("T1", "R1", base.sha);

  const applied = await workspace.applyChangeSet(task.workspaceId, {
    format: "file-set-v1",
    files: [
      { path: "src/value.js", operation: "write", content: "module.exports = 2;\n" },
      { path: "src/new.js", operation: "write", content: "module.exports = 'new';\n" },
      { path: "src/obsolete.js", operation: "delete" }
    ]
  });
  assert.equal(applied.ok, true);
  assert.deepEqual(applied.changedFiles, ["src/new.js", "src/obsolete.js", "src/value.js"]);

  const scope = await workspace.validateScope(task.workspaceId, ["src"]);
  assert.equal(scope.ok, true);
  const verification = await workspace.runVerification(task.workspaceId, { command: process.execPath, args: ["-e", "if(require('./src/value.js')!==2 || require('./src/new.js')!=='new') process.exit(7)"], timeoutMs: 5000 });
  assert.equal(verification.ok, true);

  const committed = await workspace.commit(task.workspaceId, "local task artifact");
  assert.equal(committed.ok, true);
  assert.notEqual(committed.head, base.sha);
  assert.equal((await workspace.status(task.workspaceId)).clean, true);
  assert.ok(git(["branch", "--list", task.branch], repository).includes(task.branch));

  const review = await workspace.reviewComparison(task.workspaceId);
  assert.equal(review.ok, true);
  assert.equal(review.comparison.behind_by, 0);
  assert.ok(review.comparison.ahead_by >= 1);
  assert.deepEqual(review.comparison.files.map((item) => item.filename), ["src/new.js", "src/obsolete.js", "src/value.js"]);
  assert.match(review.comparison.files.find((item) => item.filename === "src/value.js").patch, /module\.exports = 2/);
});

test("local validating provider creates a local commit from side-channel changes without remote artifact validation", async () => {
  const calls = [];
  const repositoryService = {
    async createTaskWorkspace() { calls.push("create"); return { ok: true, workspace: { workspaceId: "task:T1:R1" } }; },
    async applyWorkerChanges() { calls.push("apply"); return { ok: true, summary: { fileCount: 1 }, applied: { ok: true } }; },
    async workspaceScope() { calls.push("scope"); return { ok: true, scope: { ok: true, violations: [] } }; },
    async verifyWorkspace() { calls.push("verify"); return { ok: true, verification: { ok: true, status: "passed" } }; },
    async commitWorkspace() { calls.push("commit"); return { ok: true, commit: { ok: true, sha: "b".repeat(40), branch: "orchestra/P1/T1/R1" } }; },
    async workspaceArtifact() { calls.push("artifact"); return { ok: true, artifact: { head: "b".repeat(40), branch: "orchestra/P1/T1/R1", clean: true, changedFiles: ["src/value.js"] } }; }
  };
  const remoteProvider = {
    branchName() { return "orchestra/P1/T1/R1"; },
    async checkBaseFresh() { calls.push("freshness"); return { ok: true, currentTargetSha: "a".repeat(40) }; },
    async validateArtifact() { throw new Error("remote_validate_must_not_run"); }
  };
  const provider = new LocalValidatingGitProvider({ remoteProvider, repositoryService, logger: { warn() {} } });
  const workerArtifact = { format: "file-set-v1", files: [{ path: "src/value.js", operation: "write", content: "module.exports=2;\n" }] };
  const result = await provider.validateArtifact({
    project: { projectId: "P1", repositoryRuntime: { repositoryId: "repo-1" } },
    task: { id: "T1", kind: "code", scope: { allow: ["src/**"], deny: ["src/generated/**"] }, localVerification: [{ command: "node", args: ["--version"] }] },
    run: { runId: "R1", git: { required: true, branch: "orchestra/P1/T1/R1", baseSha: "a".repeat(40), startSha: "a".repeat(40), targetBranch: "main" } },
    snapshot: { baseSha: "a".repeat(40), defaultBranch: "main" },
    payload: { artifactFormat: "file-set-v1" },
    source: { workerArtifact }
  });
  assert.equal(result.ok, true);
  assert.equal(result.artifact.localOnly, true);
  assert.equal(result.artifact.commit, "b".repeat(40));
  assert.deepEqual(calls, ["freshness", "create", "apply", "scope", "verify", "commit", "artifact"]);
});

test("local validating provider rejects scope.deny before writing Worker changes", async () => {
  let applied = false;
  const provider = new LocalValidatingGitProvider({
    remoteProvider: { async validateArtifact() { throw new Error("remote_validate_must_not_run"); } },
    repositoryService: { async applyWorkerChanges() { applied = true; throw new Error("must_not_apply"); } },
    logger: { warn() {} }
  });
  const result = await provider.validateArtifact({
    project: { projectId: "P1", repositoryRuntime: { repositoryId: "repo-1" } },
    task: { id: "T1", kind: "code", scope: { allow: ["src/**"], deny: ["src/generated/**"] }, localVerification: [{ command: "node", args: ["--version"] }] },
    run: { runId: "R1", git: { required: true, branch: "orchestra/P1/T1/R1", baseSha: "a".repeat(40), startSha: "a".repeat(40), targetBranch: "main" } },
    snapshot: { baseSha: "a".repeat(40), defaultBranch: "main" },
    payload: { artifactFormat: "file-set-v1" },
    source: { workerArtifact: { format: "file-set-v1", files: [{ path: "src/generated/client.js", operation: "write", content: "generated\n" }] } }
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "local_scope_violation");
  assert.equal(applied, false);
  assert.deepEqual(result.local.scope.denied, ["src/generated/client.js"]);
});

test("local-bound Worker prompt forbids intermediate push and keeps file contents outside compact @@ORCH payload", () => {
  const prompt = WorkerPrompts.buildWorkerPrompt({
    project: { projectId: "P1", repository: { url: "https://github.com/acme/widget" }, repositoryRuntime: { repositoryId: "repo-1" }, initialGoal: "make a safe change" },
    task: { id: "T1", kind: "code", scope: { allow: ["src"] }, acceptanceCriteria: ["works"] },
    runId: "R1",
    agentId: "A1",
    gitAssignment: { required: true, branch: "orchestra/P1/T1/R1", targetBranch: "main", baseSha: "a".repeat(40), startSha: "a".repeat(40) }
  });
  assert.match(prompt, /file-set-v1/);
  assert.match(prompt, /Do NOT push an intermediate task branch/);
  assert.match(prompt, /@@ORCH_WORKER_ARTIFACT_BEGIN/);
  assert.match(prompt, /Worker artifact block is mandatory/);
  assert.match(prompt, /artifactFormat=file-set-v1/);
  assert.doesNotMatch(prompt, /payload\.localChanges/);
  assert.doesNotMatch(prompt, /Push the task branch before reporting DONE/);
});

test("desktop local ReviewEngine reads host-generated worktree comparison for local-only artifact", async () => {
  let remoteReviewCalled = false;
  class BaseReviewEngine {
    constructor(options = {}) { Object.assign(this, options); }
    async reviewDiff() { remoteReviewCalled = true; return { ok: false, reason: "remote_should_not_run" }; }
  }
  const LocalReviewEngine = createLocalReviewEngine(BaseReviewEngine);
  const engine = new LocalReviewEngine({ repositoryService: {
    async workspaceReviewComparison(input) {
      assert.deepEqual(input, { projectId: "P1", repositoryId: "repo-1", workspaceId: "task:T1:R1" });
      return { ok: true, comparison: { status: "ahead", ahead_by: 1, behind_by: 0, total_commits: 1, files: [{ filename: "src/value.js", patch: "@@ -1 +1 @@\n-old\n+new\n" }] } };
    }
  } });
  const result = await engine.reviewDiff({ projectId: "P1" }, { localOnly: true, repositoryId: "repo-1", workspaceId: "task:T1:R1", commit: "b".repeat(40), baseSha: "a".repeat(40) });
  assert.equal(result.ok, true);
  assert.equal(remoteReviewCalled, false);
  assert.equal(result.diff.files[0].filename, "src/value.js");
  assert.match(result.diff.files[0].patch, /\+new/);
});
