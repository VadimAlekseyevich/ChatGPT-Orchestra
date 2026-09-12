const test = require("node:test");
const assert = require("node:assert/strict");
const Git = require("../background/git-provider.js");

const BASE = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const COMMIT = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function response(data, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get(name) { return headers[String(name).toLowerCase()] ?? null; } },
    async json() { return data; }
  };
}

function project() {
  return { projectId: "P1", repository: { owner: "acme", repo: "widget", fullName: "acme/widget", url: "https://github.com/acme/widget" } };
}

function task(scope = { allow: ["src/auth/**"] }) {
  return { id: "T1", kind: "code", scope };
}

function run(branch = "orchestra/P1/T1/R1") {
  return { runId: "R1", taskId: "T1", git: { required: true, branch, targetBranch: "main", baseSha: BASE } };
}

function snapshot() {
  return {
    provider: "github-rest-v1",
    defaultBranch: "main",
    baseSha: BASE,
    cleanupPolicy: "retain_until_review_or_manual_cleanup",
    capturedAt: 1,
    lastCheckedAt: 1,
    lastFreshnessStatus: "fresh",
    currentTargetSha: BASE
  };
}

test("builds deterministic safe per-run branch names", () => {
  assert.equal(Git.taskBranchName("proj:1", "task/2", "run 3"), "orchestra/proj-1/task-2/run-3");
  assert.equal(Git.slugBranchComponent("..danger.lock"), "danger-lock");
  assert.equal(Git.slugBranchComponent("..."), "unknown");
  assert.equal(Git.isCommitSha(COMMIT), true);
  assert.equal(Git.isCommitSha("abc123"), false);
});

test("scope validator accepts allowed paths and rejects deny/outside paths", () => {
  assert.equal(Git.validateChangedFiles(["src/auth/token.js"], { allow: ["src/auth/**"] }).ok, true);
  assert.equal(
    Git.validateChangedFiles(["src/payments/pay.js"], { allow: ["src/auth/**"] }).reason,
    "changed_file_outside_scope"
  );
  assert.equal(
    Git.validateChangedFiles(["src/auth/secrets/key.js"], { allow: ["src/auth/**"], deny: ["src/auth/secrets/**"] }).reason,
    "changed_file_denied"
  );
  assert.equal(Git.matchesPattern("src/a/file.js", "**/*"), true);
  assert.equal(Git.matchesPattern("src/test.js", "src/**/test.js"), true);
  assert.equal(Git.matchesPattern("src/deep/nested/test.js", "src/**/test.js"), true);
  assert.equal(Git.matchesPattern("test.js", "src/**/test.js"), false);
});

test("captures target branch and base SHA from GitHub REST", async () => {
  const calls = [];
  const provider = new Git.GitHubRestProvider({
    clock: () => 50,
    fetchImpl: async (url) => {
      calls.push(url);
      if (url.endsWith("/repos/acme/widget")) return response({ default_branch: "main" });
      if (url.endsWith("/git/ref/heads/main")) return response({ object: { sha: BASE } });
      throw new Error(`unexpected url ${url}`);
    }
  });
  const result = await provider.captureBase(project());
  assert.equal(result.ok, true);
  assert.equal(result.snapshot.defaultBranch, "main");
  assert.equal(result.snapshot.baseSha, BASE);
  assert.equal(result.snapshot.capturedAt, 50);
  assert.equal(result.snapshot.lastFreshnessStatus, "fresh");
  assert.equal(calls.length, 2);
});

test("independently validates branch head, merge base and exact changed files", async () => {
  const branch = "orchestra/P1/T1/R1";
  const provider = new Git.GitHubRestProvider({
    clock: () => 99,
    fetchImpl: async (url) => {
      if (url.endsWith("/git/ref/heads/main")) return response({ object: { sha: BASE } });
      if (url.endsWith(`/git/ref/heads/${branch}`)) return response({ object: { sha: COMMIT } });
      if (url.endsWith(`/compare/${BASE}...${COMMIT}`)) {
        return response({
          ahead_by: 1,
          behind_by: 0,
          merge_base_commit: { sha: BASE },
          files: [{ filename: "src/auth/token.js", status: "modified" }]
        });
      }
      throw new Error(`unexpected url ${url}`);
    }
  });

  const result = await provider.validateArtifact({
    project: project(),
    task: task(),
    run: run(branch),
    snapshot: snapshot(),
    payload: {
      git: {
        branch,
        commit: COMMIT,
        baseSha: BASE,
        targetBranch: "main",
        changedFiles: ["src/auth/token.js"]
      }
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.artifact.commit, COMMIT);
  assert.deepEqual(result.artifact.changedFiles, ["src/auth/token.js"]);
  assert.equal(result.artifact.verifiedAt, 99);
});

test("rejects target movement before accepting a Worker artifact", async () => {
  const moved = "cccccccccccccccccccccccccccccccccccccccc";
  const provider = new Git.GitHubRestProvider({
    fetchImpl: async (url) => {
      if (url.endsWith("/git/ref/heads/main")) return response({ object: { sha: moved } });
      throw new Error(`unexpected url ${url}`);
    }
  });
  const result = await provider.validateArtifact({
    project: project(),
    task: task(),
    run: run(),
    snapshot: snapshot(),
    payload: { git: { branch: run().git.branch, commit: COMMIT, baseSha: BASE, targetBranch: "main", changedFiles: ["src/auth/token.js"] } }
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "target_branch_moved");
  assert.equal(result.currentTargetSha, moved);
});

test("rejects branch changes outside task scope even when Worker reports them accurately", async () => {
  const branch = run().git.branch;
  const provider = new Git.GitHubRestProvider({
    fetchImpl: async (url) => {
      if (url.endsWith("/git/ref/heads/main")) return response({ object: { sha: BASE } });
      if (url.endsWith(`/git/ref/heads/${branch}`)) return response({ object: { sha: COMMIT } });
      if (url.endsWith(`/compare/${BASE}...${COMMIT}`)) {
        return response({ ahead_by: 1, behind_by: 0, merge_base_commit: { sha: BASE }, files: [{ filename: "infra/prod.yml" }] });
      }
      throw new Error(`unexpected url ${url}`);
    }
  });
  const result = await provider.validateArtifact({
    project: project(),
    task: task(),
    run: run(),
    snapshot: snapshot(),
    payload: { git: { branch, commit: COMMIT, baseSha: BASE, targetBranch: "main", changedFiles: ["infra/prod.yml"] } }
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "changed_file_outside_scope");
});

test("rejects Worker changedFiles report that differs from GitHub compare", async () => {
  const branch = run().git.branch;
  const provider = new Git.GitHubRestProvider({
    fetchImpl: async (url) => {
      if (url.endsWith("/git/ref/heads/main")) return response({ object: { sha: BASE } });
      if (url.endsWith(`/git/ref/heads/${branch}`)) return response({ object: { sha: COMMIT } });
      if (url.endsWith(`/compare/${BASE}...${COMMIT}`)) {
        return response({ ahead_by: 1, behind_by: 0, merge_base_commit: { sha: BASE }, files: [{ filename: "src/auth/token.js" }] });
      }
      throw new Error(`unexpected url ${url}`);
    }
  });
  const result = await provider.validateArtifact({
    project: project(),
    task: task(),
    run: run(),
    snapshot: snapshot(),
    payload: { git: { branch, commit: COMMIT, baseSha: BASE, targetBranch: "main", changedFiles: ["src/auth/other.js"] } }
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "git_reported_changed_files_mismatch");
});

test("private/unavailable repository fails closed instead of trusting Worker metadata", async () => {
  const provider = new Git.GitHubRestProvider({ fetchImpl: async () => response({ message: "Not Found" }, 404) });
  const result = await provider.captureBase(project());
  assert.equal(result.ok, false);
  assert.equal(result.reason, "git_repository_or_ref_unavailable");
});
