"use strict";

const path = require("node:path");
const { LocalRepositoryRegistry, TRUST_STATES } = require("../../../platform/local-repository-registry.js");
const { SystemGitWorkspace } = require("../../../platform/system-git-workspace.js");

class DesktopRepositoryService {
  constructor({ stateStore, paths, clock = () => Date.now(), workspaceFactory = null } = {}) {
    if (!stateStore) throw new TypeError("desktop_repository_state_store_required");
    if (!paths?.repositoriesDirectory || !paths?.workspacesDirectory) throw new TypeError("desktop_repository_paths_required");
    this.paths = paths;
    this.clock = clock;
    this.registry = new LocalRepositoryRegistry({ stateStore, clock });
    this.workspaceFactory = workspaceFactory || ((options) => new SystemGitWorkspace(options));
    this.adapters = new Map();
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
    const repository = await this.registry.registerLocal({
      repositoryId,
      repositoryPath: loaded.repository?.path || repositoryPath,
      trust: TRUST_STATES.UNTRUSTED
    });
    this.adapters.set(this.adapterKey(repositoryId, repositoryId), adapter);
    return { ok: true, repository, base: await adapter.snapshotBase() };
  }

  async cloneRepository({ repositoryId, url } = {}) {
    const adapter = this.createAdapter(repositoryId, repositoryId);
    const target = path.join(this.paths.repositoriesDirectory, String(repositoryId || ""));
    const loaded = await adapter.loadRepository({ mode: "clone", sourceUrl: url, path: target });
    const repository = await this.registry.registerClone({
      repositoryId,
      repositoryPath: loaded.repository?.path || target,
      sourceUrl: url,
      trust: TRUST_STATES.UNTRUSTED
    });
    this.adapters.set(this.adapterKey(repositoryId, repositoryId), adapter);
    return { ok: true, repository, base: await adapter.snapshotBase() };
  }

  async setRepositoryTrust({ repositoryId, trust } = {}) {
    const repository = await this.registry.setTrust(repositoryId, trust);
    return { ok: true, repository };
  }

  async createTaskWorkspace(payload = {}) {
    const adapter = await this.adapterFor(payload.projectId, payload.repositoryId);
    return { ok: true, workspace: await adapter.createTaskWorkspace(payload) };
  }

  async createIntegrationWorkspace(payload = {}) {
    const adapter = await this.adapterFor(payload.projectId, payload.repositoryId);
    return { ok: true, workspace: await adapter.createIntegrationWorkspace(payload) };
  }

  async workspaceStatus(payload = {}) {
    const adapter = await this.adapterFor(payload.projectId, payload.repositoryId);
    return { ok: true, status: await adapter.status(payload.workspaceId) };
  }

  async workspaceDiff(payload = {}) {
    const adapter = await this.adapterFor(payload.projectId, payload.repositoryId);
    return { ok: true, diff: await adapter.diff(payload.workspaceId) };
  }

  async workspaceScope(payload = {}) {
    const adapter = await this.adapterFor(payload.projectId, payload.repositoryId);
    return { ok: true, scope: await adapter.validateScope(payload.workspaceId, { allow: payload.allowedPaths || payload.allow || [] }) };
  }

  async verifyWorkspace(payload = {}) {
    const adapter = await this.adapterFor(payload.projectId, payload.repositoryId);
    const verification = await adapter.runVerification(payload.workspaceId, {
      command: payload.command,
      args: payload.args,
      runId: payload.runId,
      timeoutMs: payload.timeoutMs,
      maxOutputBytes: payload.maxOutputBytes,
      environment: payload.environment
    });
    return { ok: verification.ok === true, verification };
  }

  async commitWorkspace(payload = {}) {
    const adapter = await this.adapterFor(payload.projectId, payload.repositoryId);
    const commit = await adapter.commit(payload.workspaceId, { message: payload.message });
    return commit?.ok === false ? commit : { ok: true, commit };
  }

  async cleanupWorkspace(payload = {}) {
    const adapter = await this.adapterFor(payload.projectId, payload.repositoryId);
    const cleanup = await adapter.cleanup(payload.workspaceId, { force: payload.force === true, deleteBranch: payload.deleteBranch === true });
    return cleanup === true ? { ok: true, workspaceId: payload.workspaceId } : { ok: Boolean(cleanup?.ok), cleanup };
  }
}

module.exports = { DesktopRepositoryService };
