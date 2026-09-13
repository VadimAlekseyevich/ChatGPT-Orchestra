"use strict";

const path = require("node:path");
const { LocalRepositoryRegistry, TRUST_STATES } = require("../../../platform/local-repository-registry.js");
const { SystemGitWorkspace } = require("../../../platform/system-git-workspace.js");
const { WorkspaceLifecyclePolicy } = require("./workspace-lifecycle.js");

class DesktopRepositoryService {
  constructor({ stateStore, paths, clock = () => Date.now(), workspaceFactory = null, logger = null, lifecyclePolicy = null } = {}) {
    if (!stateStore) throw new TypeError("desktop_repository_state_store_required");
    if (!paths?.repositoriesDirectory || !paths?.workspacesDirectory) throw new TypeError("desktop_repository_paths_required");
    this.paths = paths;
    this.clock = clock;
    this.logger = logger;
    this.registry = new LocalRepositoryRegistry({ stateStore, clock });
    this.workspaceFactory = workspaceFactory || ((options) => new SystemGitWorkspace(options));
    this.lifecyclePolicy = lifecyclePolicy || new WorkspaceLifecyclePolicy({ clock });
    this.adapters = new Map();
    this.activeVerificationRuns = new Map();
    this.verificationSequence = 0;
  }

  audit(event, details = {}) {
    this.logger?.info?.("repository_audit", { event: String(event || "unknown"), ...details, at: this.clock() });
  }

  adapterKey(projectId, repositoryId) {
    return `${String(projectId || "")}::${String(repositoryId || "")}`;
  }

  createAdapter(projectId, repositoryId) {
    return this.workspaceFactory({
      projectId,
      repositoryId,
      workspaceRoot: this.paths.workspacesDirectory,
      repositoriesRoot: this.paths.repositoriesDirectory,
      trustResolver: async (id) => (await this.registry.get(id))?.trust || TRUST_STATES.UNTRUSTED,
      clock: this.clock
    });
  }

  async adapterFor(projectId, repositoryId) {
    const repository = await this.registry.get(repositoryId);
    if (!repository) throw new Error("repository_not_registered");
    const key = this.adapterKey(projectId, repositoryId);
    let adapter = this.adapters.get(key);
    if (!adapter) {
      adapter = this.createAdapter(projectId, repositoryId);
      await adapter.loadRepository({ mode: "local", path: repository.path });
      this.adapters.set(key, adapter);
    }
    return adapter;
  }

  async listRepositories() {
    return { ok: true, repositories: await this.registry.list() };
  }

  async getRepository(repositoryId) {
    const repository = await this.registry.get(repositoryId);
    return repository ? { ok: true, repository } : { ok: false, reason: "repository_not_registered" };
  }

  async openLocalRepository({ repositoryId, path: repositoryPath } = {}) {
    const adapter = this.createAdapter(repositoryId, repositoryId);
    const loaded = await adapter.loadRepository({ mode: "local", path: repositoryPath });
    const repository = await this.registry.registerLocal({ repositoryId, repositoryPath: loaded.repository?.path || repositoryPath, trust: TRUST_STATES.UNTRUSTED });
    this.adapters.set(this.adapterKey(repositoryId, repositoryId), adapter);
    this.audit("repository_opened", { repositoryId: repository.repositoryId, mode: "local", trust: repository.trust });
    return { ok: true, repository, base: await adapter.snapshotBase() };
  }

  async cloneRepository({ repositoryId, url } = {}) {
    const adapter = this.createAdapter(repositoryId, repositoryId);
    const target = path.join(this.paths.repositoriesDirectory, String(repositoryId || ""));
    const loaded = await adapter.loadRepository({ mode: "clone", sourceUrl: url, path: target });
    const repository = await this.registry.registerClone({ repositoryId, repositoryPath: loaded.repository?.path || target, sourceUrl: url, trust: TRUST_STATES.UNTRUSTED });
    this.adapters.set(this.adapterKey(repositoryId, repositoryId), adapter);
    this.audit("repository_cloned", { repositoryId: repository.repositoryId, mode: "clone", trust: repository.trust });
    return { ok: true, repository, base: await adapter.snapshotBase() };
  }

  async setRepositoryTrust({ repositoryId, trust } = {}) {
    const before = await this.registry.get(repositoryId);
    const repository = await this.registry.setTrust(repositoryId, trust);
    this.audit("repository_trust_changed", { repositoryId, from: before?.trust || null, to: repository.trust });
    return { ok: true, repository };
  }

  async createTaskWorkspace(payload = {}) {
    const adapter = await this.adapterFor(payload.projectId, payload.repositoryId);
    const workspace = await adapter.createTaskWorkspace(payload);
    this.audit("task_workspace_created", { projectId: payload.projectId, repositoryId: payload.repositoryId, taskId: payload.taskId, runId: payload.runId, workspaceId: workspace.workspaceId });
    return { ok: true, workspace };
  }

  async createIntegrationWorkspace(payload = {}) {
    const adapter = await this.adapterFor(payload.projectId, payload.repositoryId);
    const workspace = await adapter.createIntegrationWorkspace(payload);
    this.audit("integration_workspace_created", { projectId: payload.projectId, repositoryId: payload.repositoryId, runId: payload.runId, workspaceId: workspace.workspaceId });
    return { ok: true, workspace };
  }

  async workspaceStatus(payload = {}) {
    const adapter = await this.adapterFor(payload.projectId, payload.repositoryId);
    return { ok: true, status: await adapter.status(payload.workspaceId) };
  }

  async workspaceDiff(payload = {}) {
    const adapter = await this.adapterFor(payload.projectId, payload.repositoryId);
    return { ok: true, diff: await adapter.diff(payload.workspaceId) };
  }

  async workspaceArtifact(payload = {}) {
    const adapter = await this.adapterFor(payload.projectId, payload.repositoryId);
    return { ok: true, artifact: await adapter.artifactState(payload.workspaceId) };
  }

  async workspaceScope(payload = {}) {
    const adapter = await this.adapterFor(payload.projectId, payload.repositoryId);
    return { ok: true, scope: await adapter.validateScope(payload.workspaceId, { allow: payload.allowedPaths || payload.allow || [] }) };
  }

  async workspaceRecoveryReport(payload = {}) {
    const adapter = await this.adapterFor(payload.projectId, payload.repositoryId);
    return this.lifecyclePolicy.scan(adapter, { activeWorkspaceIds: payload.activeWorkspaceIds || [], retentionMs: payload.retentionMs });
  }

  async cleanupAbandonedWorkspaces(payload = {}) {
    const adapter = await this.adapterFor(payload.projectId, payload.repositoryId);
    const result = await this.lifecyclePolicy.cleanup(adapter, { activeWorkspaceIds: payload.activeWorkspaceIds || [], retentionMs: payload.retentionMs });
    this.audit("abandoned_workspaces_cleanup", {
      projectId: payload.projectId,
      repositoryId: payload.repositoryId,
      cleanedCount: result.cleaned.length,
      salvageCount: result.salvage.length,
      failedCount: result.failed.length
    });
    return result;
  }

  async materializeTaskArtifact(payload = {}) {
    const adapter = await this.adapterFor(payload.projectId, payload.repositoryId);
    const artifact = await adapter.materializeTaskArtifact(payload.workspaceId, { commit: payload.commit, branch: payload.branch, remote: payload.remote });
    this.audit("task_artifact_materialized", { projectId: payload.projectId, repositoryId: payload.repositoryId, workspaceId: payload.workspaceId, commit: artifact.head });
    return { ok: artifact.ok === true, artifact };
  }

  verificationMetadata(payload = {}, runId) {
    return {
      projectId: payload.projectId,
      repositoryId: payload.repositoryId,
      workspaceId: payload.workspaceId,
      runId,
      command: String(payload.command || ""),
      argCount: Array.isArray(payload.args) ? payload.args.length : 0,
      timeoutMs: Number(payload.timeoutMs) || null,
      startedAt: this.clock()
    };
  }

  listActiveVerificationRuns(payload = {}) {
    const projectId = payload.projectId ? String(payload.projectId) : null;
    const repositoryId = payload.repositoryId ? String(payload.repositoryId) : null;
    const runs = [...this.activeVerificationRuns.values()].filter((item) => (
      (!projectId || item.projectId === projectId)
      && (!repositoryId || item.repositoryId === repositoryId)
    )).map((item) => ({ ...item }));
    return { ok: true, runs };
  }

  async cancelVerification(payload = {}) {
    const runId = String(payload.runId || "").trim();
    if (!runId) return { ok: false, reason: "verification_run_id_missing" };
    const active = this.activeVerificationRuns.get(runId);
    if (!active) return { ok: false, reason: "verification_run_not_active", runId };
    if (payload.projectId && String(payload.projectId) !== active.projectId) return { ok: false, reason: "verification_run_project_mismatch", runId };
    if (payload.repositoryId && String(payload.repositoryId) !== active.repositoryId) return { ok: false, reason: "verification_run_repository_mismatch", runId };
    const adapter = await this.adapterFor(active.projectId, active.repositoryId);
    const cancelled = typeof adapter.cancelVerification === "function"
      ? adapter.cancelVerification(runId)
      : adapter.commandRunner?.cancel?.(runId) === true;
    if (!cancelled) return { ok: false, reason: "verification_cancel_failed", runId };
    const updated = { ...active, cancelRequestedAt: this.clock() };
    this.activeVerificationRuns.set(runId, updated);
    this.audit("verification_cancel_requested", { projectId: active.projectId, repositoryId: active.repositoryId, workspaceId: active.workspaceId, runId });
    return { ok: true, runId };
  }

  async verifyWorkspace(payload = {}) {
    const adapter = await this.adapterFor(payload.projectId, payload.repositoryId);
    const runId = String(payload.runId || `verify:${this.clock()}:${++this.verificationSequence}`);
    if (this.activeVerificationRuns.has(runId)) return { ok: false, reason: "verification_run_already_active", runId };
    const metadata = this.verificationMetadata(payload, runId);
    this.activeVerificationRuns.set(runId, metadata);
    this.audit("verification_started", metadata);
    try {
      const verification = await adapter.runVerification(payload.workspaceId, {
        command: payload.command,
        args: payload.args,
        runId,
        timeoutMs: payload.timeoutMs,
        maxOutputBytes: payload.maxOutputBytes
      });
      this.audit("verification_finished", {
        ...metadata,
        status: verification.status,
        exitCode: verification.exitCode,
        stdoutTruncated: verification.stdoutTruncated === true,
        stderrTruncated: verification.stderrTruncated === true,
        startedAt: verification.startedAt,
        finishedAt: verification.finishedAt
      });
      return { ok: verification.ok === true, verification };
    } catch (error) {
      const reason = String(error?.message || "verification_failed");
      this.audit("verification_rejected", { ...metadata, reason: /^[a-z0-9_:-]+$/i.test(reason) ? reason : "verification_failed" });
      throw error;
    } finally {
      this.activeVerificationRuns.delete(runId);
    }
  }

  async commitWorkspace(payload = {}) {
    const adapter = await this.adapterFor(payload.projectId, payload.repositoryId);
    const commit = await adapter.commit(payload.workspaceId, { message: payload.message });
    this.audit("workspace_committed", { projectId: payload.projectId, repositoryId: payload.repositoryId, workspaceId: payload.workspaceId, ok: commit?.ok === true, commit: commit?.sha || commit?.head || null });
    return commit?.ok === false ? commit : { ok: true, commit };
  }

  async mergeTaskArtifact(payload = {}) {
    const adapter = await this.adapterFor(payload.projectId, payload.repositoryId);
    const merge = await adapter.mergeTaskArtifact(payload.integrationWorkspaceId || payload.workspaceId, payload.taskCommit, { message: payload.message });
    this.audit("integration_merge", { projectId: payload.projectId, repositoryId: payload.repositoryId, workspaceId: payload.integrationWorkspaceId || payload.workspaceId, taskCommit: payload.taskCommit, ok: merge.ok === true, reason: merge.reason || null });
    return { ok: merge.ok === true, merge };
  }

  async pushWorkspace(payload = {}) {
    const adapter = await this.adapterFor(payload.projectId, payload.repositoryId);
    const push = await adapter.push(payload.workspaceId, { remote: payload.remote, branch: payload.branch, validated: payload.validated === true });
    this.audit("workspace_pushed", { projectId: payload.projectId, repositoryId: payload.repositoryId, workspaceId: payload.workspaceId, remote: push.remote, branch: push.branch });
    return { ok: push.ok === true, push };
  }

  async cleanupWorkspace(payload = {}) {
    const adapter = await this.adapterFor(payload.projectId, payload.repositoryId);
    const cleanup = await adapter.cleanup(payload.workspaceId, { force: payload.force === true, deleteBranch: payload.deleteBranch === true });
    this.audit("workspace_cleaned", { projectId: payload.projectId, repositoryId: payload.repositoryId, workspaceId: payload.workspaceId, forced: payload.force === true, deleteBranch: payload.deleteBranch === true });
    return cleanup === true ? { ok: true, workspaceId: payload.workspaceId } : { ok: Boolean(cleanup?.ok), cleanup };
  }
}

module.exports = { DesktopRepositoryService };
