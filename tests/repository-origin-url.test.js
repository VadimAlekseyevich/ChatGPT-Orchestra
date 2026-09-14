"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  DesktopRepositoryService,
  canonicalGitHubRepositoryUrl
} = require("../apps/desktop/main/repository-service.js");

function memoryStateStore() {
  const data = {};
  return {
    async get(key) { return { [key]: data[key] }; },
    async set(values) { Object.assign(data, values); }
  };
}

test("canonical GitHub repository URL accepts common HTTPS and SSH origin forms", () => {
  assert.equal(canonicalGitHubRepositoryUrl("https://github.com/acme/widget"), "https://github.com/acme/widget");
  assert.equal(canonicalGitHubRepositoryUrl("https://github.com/acme/widget.git"), "https://github.com/acme/widget");
  assert.equal(canonicalGitHubRepositoryUrl("git@github.com:acme/widget.git"), "https://github.com/acme/widget");
  assert.equal(canonicalGitHubRepositoryUrl("ssh://git@github.com/acme/widget.git"), "https://github.com/acme/widget");
});

test("canonical GitHub repository URL rejects non-GitHub, insecure and decorated origins", () => {
  assert.equal(canonicalGitHubRepositoryUrl("http://github.com/acme/widget"), null);
  assert.equal(canonicalGitHubRepositoryUrl("https://gitlab.com/acme/widget"), null);
  assert.equal(canonicalGitHubRepositoryUrl("https://github.com/acme/widget?token=x"), null);
  assert.equal(canonicalGitHubRepositoryUrl("https://github.com/acme/widget#branch"), null);
  assert.equal(canonicalGitHubRepositoryUrl("git@evil.example:acme/widget.git"), null);
});

test("opening a local repository returns canonical GitHub origin without persisting it as a filesystem identity", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-origin-"));
  const repositoryPath = path.join(root, "repo");
  const repositoriesDirectory = path.join(root, "repositories");
  const workspacesDirectory = path.join(root, "workspaces");
  fs.mkdirSync(repositoryPath, { recursive: true });
  fs.mkdirSync(repositoriesDirectory, { recursive: true });
  fs.mkdirSync(workspacesDirectory, { recursive: true });

  const workspaceFactory = () => ({
    repository: null,
    async loadRepository() {
      this.repository = { path: repositoryPath };
      return { ok: true, repository: { path: repositoryPath } };
    },
    requireRepository() { return this.repository; },
    async execGit(args) {
      assert.deepEqual(args, ["remote", "get-url", "origin"]);
      return { stdout: "git@github.com:acme/widget.git\n", stderr: "" };
    },
    async snapshotBase() {
      return { ok: true, repositoryId: "repo-local", baseSha: "a".repeat(40), targetBranch: "main", changedFiles: [] };
    }
  });

  const service = new DesktopRepositoryService({
    stateStore: memoryStateStore(),
    paths: { repositoriesDirectory, workspacesDirectory },
    workspaceFactory,
    clock: () => 100
  });

  const opened = await service.openLocalRepository({ repositoryId: "repo-local", path: repositoryPath });
  assert.equal(opened.ok, true);
  assert.equal(opened.repositoryUrl, "https://github.com/acme/widget");
  assert.equal(opened.repository.repositoryId, "repo-local");
  assert.equal(opened.repository.sourceUrl, null);
  assert.equal(opened.repository.trust, "UNTRUSTED");
});
