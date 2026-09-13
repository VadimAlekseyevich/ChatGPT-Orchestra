"use strict";

class LocalValidatingGitProvider {
  constructor({ remoteProvider, repositoryService, logger = console } = {}) {
    if (!remoteProvider) throw new TypeError("remote_git_provider_required");
    if (!repositoryService) throw new TypeError("repository_service_required");
    this.remoteProvider = remoteProvider;
    this.repositoryService = repositoryService;
    this.logger = logger;
  }

  branchName(...args) { return this.remoteProvider.branchName(...args); }
  captureBase(...args) { return this.remoteProvider.captureBase(...args); }
  checkBaseFresh(...args) { return this.remoteProvider.checkBaseFresh(...args); }

  async validateArtifact(input = {}) {
    const remote = await this.remoteProvider.validateArtifact(input);
    if (!remote?.ok) return remote;

    const project = input.project || null;
    const task = input.task || null;
    const run = input.run || null;
    const repositoryId = project?.repositoryRuntime?.repositoryId || null;
    if (!repositoryId) return remote;
    if (!task?.id || !run?.runId) {
      return { ok: false, reason: "git_repository_identity_missing", remote, local: { ok: false, reason: "local_run_identity_missing" } };
    }

    let workspaceId = null;
    try {
      const created = await this.repositoryService.createTaskWorkspace({
        projectId: project.projectId,
        repositoryId,
        taskId: task.id,
        runId: run.runId,
        startSha: run.git?.startSha || run.git?.baseSha || input.snapshot?.baseSha || "HEAD"
      });
      workspaceId = created?.workspace?.workspaceId || null;
    } catch (error) {
      if (String(error?.message || "") !== "git_workspace_already_exists") {
        return {
          ok: false,
          reason: "git_repository_or_ref_unavailable",
          remote,
          local: { ok: false, reason: "local_workspace_create_failed", error: String(error?.message || error) }
        };
      }
      workspaceId = `task:${task.id}:${run.runId}`;
    }

    try {
      const materialized = await this.repositoryService.materializeTaskArtifact({
        projectId: project.projectId,
        repositoryId,
        workspaceId,
        commit: remote.artifact?.commit,
        branch: remote.artifact?.branch || run.git?.branch,
        remote: "origin"
      });
      const scope = await this.repositoryService.workspaceScope({
        projectId: project.projectId,
        repositoryId,
        workspaceId,
        allowedPaths: task.scope?.allow || []
      });
      const localArtifact = materialized?.artifact || null;
      const localScope = scope?.scope || null;
      if (!materialized?.ok || !localArtifact?.head) {
        return { ok: false, reason: "git_repository_or_ref_unavailable", remote, local: { ok: false, reason: "local_artifact_materialize_failed", materialized } };
      }
      if (!localScope?.ok) {
        return { ok: false, reason: "local_scope_violation", remote, local: { ok: false, workspaceId, artifact: localArtifact, scope: localScope } };
      }
      return {
        ...remote,
        artifact: {
          ...remote.artifact,
          remoteChangedFiles: remote.artifact?.changedFiles || [],
          changedFiles: localArtifact.changedFiles || [],
          workspaceId,
          repositoryId
        },
        local: { ok: true, workspaceId, artifact: localArtifact, scope: localScope }
      };
    } catch (error) {
      this.logger?.warn?.("local_artifact_validation_failed", { projectId: project.projectId, taskId: task.id, runId: run.runId, repositoryId, error: String(error?.message || error) });
      return {
        ok: false,
        reason: "git_repository_or_ref_unavailable",
        remote,
        local: { ok: false, reason: "local_artifact_validation_failed", workspaceId, error: String(error?.message || error) }
      };
    }
  }
}

module.exports = { LocalValidatingGitProvider };
