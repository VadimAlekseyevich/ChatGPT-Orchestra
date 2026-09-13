"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { NodeCommandRunner, isInside } = require("./node-command-runner.js");
const { TRUST_STATES } = require("./local-repository-registry.js");

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT_BYTES = 2 * 1024 * 1024;

function safeSegment(value, label) {
  const segment = String(value || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(segment)) throw new Error(`${label}_invalid`);
  return segment;
}

function normalizeRelativePath(value) {
  const normalized = String(value || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/g, "");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) throw new Error("workspace_scope_path_invalid");
  return normalized;
}

function inScope(changedPath, allowedPath) {
  return changedPath === allowedPath || changedPath.startsWith(`${allowedPath}/`);
}

function atomicWriteJson(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, filename);
}

function readJson(filename, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filename, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

class GitCliWorkspace {
  constructor({
    projectId,
    repositoryId,
    workspaceRoot,
    repositoriesRoot = null,
    gitBinary = "git",
    execFileImpl = execFileAsync,
    commandRunner = null,
    trustResolver = async () => TRUST_STATES.UNTRUSTED,
    clock = () => Date.now()
  } = {}) {
    this.projectId = safeSegment(projectId, "workspace_project_id");
    this.repositoryId = safeSegment(repositoryId || projectId, "workspace_repository_id");
    this.workspaceRoot = path.resolve(String(workspaceRoot || ""));
    this.repositoriesRoot = path.resolve(String(repositoriesRoot || path.join(this.workspaceRoot, "..", "repositories")));
    fs.mkdirSync(this.workspaceRoot, { recursive: true });
    fs.mkdirSync(this.repositoriesRoot, { recursive: true });
    this.metadataRoot = path.join(this.workspaceRoot, ".orchestra-meta", this.projectId);
    this.metadataFile = path.join(this.metadataRoot, "workspaces.json");
    this.hooksDirectory = path.join(this.metadataRoot, "empty-hooks");
    fs.mkdirSync(this.hooksDirectory, { recursive: true });
    this.gitBinary = gitBinary;
    this.execFileImpl = execFileImpl;
    this.commandRunner = commandRunner || new NodeCommandRunner({ workspaceRoot: this.workspaceRoot, clock });
    this.trustResolver = trustResolver;
    this.clock = clock;
    this.repository = null;
    this.workspaces = new Map();
    this.loadWorkspaceIndex();
  }

  loadWorkspaceIndex() {
    const stored = readJson(this.metadataFile, { schemaVersion: 1, workspaces: {} });
    if (stored?.schemaVersion !== 1 || !stored.workspaces || typeof stored.workspaces !== "object") throw new Error("workspace_metadata_invalid");
    this.workspaces = new Map(Object.entries(stored.workspaces));
  }

  persistWorkspaceIndex() {
    atomicWriteJson(this.metadataFile, {
      schemaVersion: 1,
      projectId: this.projectId,
      repositoryId: this.repositoryId,
      workspaces: Object.fromEntries(this.workspaces),
      updatedAt: this.clock()
    });
  }

  async execGit(args, { cwd = null } = {}) {
    const result = await this.execFileImpl(this.gitBinary, args, {
      cwd: cwd || this.repository?.path || this.workspaceRoot,
      windowsHide: true,
      encoding: "utf8",
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      env: process.env
    });
    return { stdout: String(result.stdout || ""), stderr: String(result.stderr || "") };
  }

  async canonicalRepositoryPath(repositoryPath) {
    const candidate = fs.realpathSync(path.resolve(String(repositoryPath || "")));
    if (!fs.statSync(candidate).isDirectory()) throw new Error("git_repository_path_not_directory");
    const { stdout } = await this.execGit(["rev-parse", "--show-toplevel"], { cwd: candidate });
    return fs.realpathSync(stdout.trim());
  }

  async loadRepository(input) {
    const request = typeof input === "string" ? { mode: "local", path: input } : { ...(input || {}) };
    const mode = request.mode || (request.sourceUrl ? "clone" : "local");
    let repositoryPath;
    let sourceUrl = null;

    if (mode === "clone") {
      sourceUrl = String(request.sourceUrl || request.url || "").trim();
      if (!sourceUrl || /[\r\n\0]/.test(sourceUrl)) throw new Error("git_clone_url_invalid");
      const target = path.resolve(request.path || path.join(this.repositoriesRoot, this.repositoryId));
      if (!isInside(this.repositoriesRoot, target)) throw new Error("git_clone_target_outside_repositories_root");
      if (fs.existsSync(target)) throw new Error("git_clone_target_exists");
      fs.mkdirSync(path.dirname(target), { recursive: true });
      await this.execGit(["clone", "--", sourceUrl, target], { cwd: path.dirname(target) });
      repositoryPath = await this.canonicalRepositoryPath(target);
    } else if (mode === "local") {
      repositoryPath = await this.canonicalRepositoryPath(request.path);
    } else {
      throw new Error("git_repository_mode_invalid");
    }

    const { stdout: head } = await this.execGit(["rev-parse", "HEAD"], { cwd: repositoryPath });
    this.repository = {
      repositoryId: this.repositoryId,
      mode,
      path: repositoryPath,
      sourceUrl,
      head: head.trim(),
      loadedAt: this.clock()
    };
    return { ...this.repository };
  }

  requireRepository() {
    if (!this.repository?.path) throw new Error("git_repository_not_loaded");
    return this.repository;
  }

  async snapshotBase(ref = "HEAD") {
    const repository = this.requireRepository();
    const requested = String(ref || "HEAD");
    if (/[\r\n\0]/.test(requested)) throw new Error("git_ref_invalid");
    const { stdout: sha } = await this.execGit(["rev-parse", "--verify", "--end-of-options", `${requested}^{commit}`], { cwd: repository.path });
    let branch = null;
    try {
      branch = (await this.execGit(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: repository.path })).stdout.trim() || null;
    } catch {}
    return {
      repositoryId: this.repositoryId,
      sha: sha.trim(),
      branch,
      changedFiles: await this.changedFilesAt(repository.path)
    };
  }

  workspaceRecord(workspaceId) {
    const record = this.workspaces.get(String(workspaceId || ""));
    if (!record) throw new Error("git_workspace_not_found");
    const resolved = path.resolve(record.path);
    if (!isInside(this.workspaceRoot, resolved)) throw new Error("git_workspace_path_outside_root");
    if (!fs.existsSync(resolved)) throw new Error("git_workspace_missing");
    return { ...record, path: resolved };
  }

  async verifyStartSha(startSha) {
    const repository = this.requireRepository();
    const ref = String(startSha || "HEAD");
    if (/[\r\n\0]/.test(ref)) throw new Error("git_start_sha_invalid");
    const { stdout } = await this.execGit(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], { cwd: repository.path });
    return stdout.trim();
  }

  async createWorkspace({ kind, taskId = null, runId, startSha = "HEAD" }) {
    const repository = this.requireRepository();
    const safeRun = safeSegment(runId, "workspace_run_id");
    const safeTask = taskId === null ? null : safeSegment(taskId, "workspace_task_id");
    const sha = await this.verifyStartSha(startSha);
    const workspaceId = kind === "integration" ? `integration:${safeRun}` : `task:${safeTask}:${safeRun}`;
    if (this.workspaces.has(workspaceId)) throw new Error("git_workspace_already_exists");
    const branch = kind === "integration"
      ? `orchestra/${this.projectId}/integration/${safeRun}`
      : `orchestra/${this.projectId}/${safeTask}/${safeRun}`;
    const workspacePath = kind === "integration"
      ? path.join(this.workspaceRoot, this.projectId, "integration", safeRun)
      : path.join(this.workspaceRoot, this.projectId, safeTask, safeRun);
    if (fs.existsSync(workspacePath)) throw new Error("git_workspace_path_exists");
    fs.mkdirSync(path.dirname(workspacePath), { recursive: true });
    await this.execGit(["worktree", "add", "-b", branch, workspacePath, sha], { cwd: repository.path });
    const record = {
      schemaVersion: 1,
      workspaceId,
      repositoryId: this.repositoryId,
      projectId: this.projectId,
      kind,
      taskId: safeTask,
      runId: safeRun,
      path: workspacePath,
      branch,
      startSha: sha,
      createdAt: this.clock()
    };
    this.workspaces.set(workspaceId, record);
    this.persistWorkspaceIndex();
    return { ...record };
  }

  async createTaskWorkspace(taskId, runId, startSha = "HEAD") {
    return this.createWorkspace({ kind: "task", taskId, runId, startSha });
  }

  async createIntegrationWorkspace(runId, startSha = "HEAD") {
    return this.createWorkspace({ kind: "integration", runId, startSha });
  }

  async changedFilesAt(cwd) {
    const tracked = (await this.execGit(["diff", "--name-only", "-z", "HEAD", "--"], { cwd })).stdout;
    const untracked = (await this.execGit(["ls-files", "--others", "--exclude-standard", "-z", "--"], { cwd })).stdout;
    return [...new Set(`${tracked}${untracked}`.split("\0").filter(Boolean).map((item) => item.replace(/\\/g, "/")))].sort();
  }

  async status(workspaceId) {
    const record = this.workspaceRecord(workspaceId);
    const [{ stdout: head }, { stdout: porcelain }, changedFiles] = await Promise.all([
      this.execGit(["rev-parse", "HEAD"], { cwd: record.path }),
      this.execGit(["status", "--porcelain=v1", "--untracked-files=all"], { cwd: record.path }),
      this.changedFilesAt(record.path)
    ]);
    return {
      workspaceId: record.workspaceId,
      branch: record.branch,
      head: head.trim(),
      clean: changedFiles.length === 0,
      changedFiles,
      porcelain
    };
  }

  async diff(workspaceId) {
    const record = this.workspaceRecord(workspaceId);
    const [{ stdout: patch }, changedFiles] = await Promise.all([
      this.execGit(["diff", "--no-ext-diff", "--binary", "HEAD", "--"], { cwd: record.path }),
      this.changedFilesAt(record.path)
    ]);
    return { workspaceId: record.workspaceId, changedFiles, patch };
  }

  async validateScope(workspaceId, allowedPaths = []) {
    const record = this.workspaceRecord(workspaceId);
    const changedFiles = await this.changedFilesAt(record.path);
    const allowed = (allowedPaths || []).map(normalizeRelativePath);
    const violations = changedFiles.filter((changed) => !allowed.some((scope) => inScope(changed, scope)));
    return {
      workspaceId: record.workspaceId,
      ok: violations.length === 0,
      changedFiles,
      allowedPaths: allowed,
      violations
    };
  }

  async repositoryTrust() {
    const trust = await this.trustResolver(this.repositoryId);
    return String(trust || TRUST_STATES.UNTRUSTED).toUpperCase();
  }

  async runVerification(workspaceId, verification = {}) {
    const record = this.workspaceRecord(workspaceId);
    const trust = await this.repositoryTrust();
    if (trust !== TRUST_STATES.TRUSTED) throw new Error("repository_execution_not_trusted");
    return this.commandRunner.run(
      String(verification.command || ""),
      Array.isArray(verification.args) ? verification.args : [],
      record.path,
      {
        trusted: true,
        runId: verification.runId || `verify:${record.workspaceId}`,
        timeoutMs: verification.timeoutMs,
        maxOutputBytes: verification.maxOutputBytes,
        environment: verification.environment || {}
      }
    );
  }

  async commit(workspaceId, message) {
    const record = this.workspaceRecord(workspaceId);
    const commitMessage = String(message || "").trim();
    if (!commitMessage || /\0/.test(commitMessage)) throw new Error("git_commit_message_invalid");
    const before = await this.status(workspaceId);
    if (before.clean) return { ok: false, reason: "no_changes", workspaceId: record.workspaceId, head: before.head };
    await this.execGit(["add", "-A", "--"], { cwd: record.path });
    await this.execGit(["-c", `core.hooksPath=${this.hooksDirectory}`, "commit", "--no-gpg-sign", "-m", commitMessage], { cwd: record.path });
    const { stdout: head } = await this.execGit(["rev-parse", "HEAD"], { cwd: record.path });
    return { ok: true, workspaceId: record.workspaceId, branch: record.branch, head: head.trim() };
  }

  async cleanup(workspaceId, { force = false, deleteBranch = false } = {}) {
    const repository = this.requireRepository();
    const record = this.workspaceRecord(workspaceId);
    const current = await this.status(workspaceId);
    if (!current.clean && !force) throw new Error("git_workspace_dirty");
    const args = ["worktree", "remove"];
    if (force) args.push("--force");
    args.push(record.path);
    await this.execGit(args, { cwd: repository.path });
    if (deleteBranch) await this.execGit(["branch", "-D", "--", record.branch], { cwd: repository.path });
    this.workspaces.delete(record.workspaceId);
    this.persistWorkspaceIndex();
    return { ok: true, workspaceId: record.workspaceId, branch: record.branch };
  }
}

module.exports = {
  GitCliWorkspace,
  MAX_GIT_OUTPUT_BYTES,
  safeSegment,
  normalizeRelativePath,
  inScope
};
