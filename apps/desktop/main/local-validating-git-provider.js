"use strict";

const {
  requiresLocalVerification,
  normalizeLocalVerificationPlan
} = require("../../../platform/local-verification.js");

class LocalValidatingGitProvider {
  constructor({ remoteProvider, repositoryService, logger = console } = {}) {
    if (!remoteProvider) throw new TypeError("remote_git_provider_required");
    if (!repositoryService) throw new TypeError("repository_service_required");
    this.remoteProvider = remoteProvider;
    this.repositoryService = repositoryService;
    this.logger = logger;
  }

  branchName(...args) { return this.remoteProvider.branchName(...args); }
  request(...args) { return this.remoteProvider.request(...args); }
  getRepository(...args) { return this.remoteProvider.getRepository(...args); }
  getBranchHead(...args) { return this.remoteProvider.getBranchHead(...args); }
  compare(...args) { return this.remoteProvider.compare(...args); }
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

    const waived = Boolean(String(task.verificationWaiver || "").trim());
    const verificationPlan = normalizeLocalVerificationPlan(task.localVerification, {
      required: requiresLocalVerification(task) && !waived
    });
    if (!verificationPlan.ok) {
      return {
        ok: false,
        reason: "git_provider_local_verification_plan_invalid",
        remote,
        local: { ok: false, reason: verificationPlan.reason, verificationPlan }
      };
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

      const verification = [];
      for (let index = 0; index < verificationPlan.commands.length; index += 1) {
        const command = verificationPlan.commands[index];
        let checked;
        try {
          checked = await this.repositoryService.verifyWorkspace({
            projectId: project.projectId,
            repositoryId,
            workspaceId,
            command: command.command,
            args: command.args,
            timeoutMs: command.timeoutMs,
            runId: `local-verify:${run.runId}:${index + 1}`
          });
        } catch (error) {
          if (String(error?.message || "") === "repository_execution_not_trusted") {
            return {
              ok: false,
              reason: "git_provider_repository_execution_not_trusted",
              remote,
              local: { ok: false, reason: "repository_execution_not_trusted", workspaceId, artifact: localArtifact, scope: localScope, verification }
            };
          }
          throw error;
        }
        const result = checked?.verification || null;
        verification.push({
          index,
          label: command.label || null,
          command: command.command,
          argCount: command.args.length,
          result
        });
        if (!checked?.ok || !result?.ok) {
          return {
            ok: false,
            reason: "local_verification_failed",
            remote,
            local: { ok: false, reason: "local_verification_failed", workspaceId, artifact: localArtifact, scope: localScope, verification }
          };
        }
      }

      return {
        ...remote,
        artifact: {
          ...remote.artifact,
          remoteChangedFiles: remote.artifact?.changedFiles || [],
          changedFiles: localArtifact.changedFiles || [],
          workspaceId,
          repositoryId,
          localVerificationPassed: true
        },
        local: {
          ok: true,
          workspaceId,
          artifact: localArtifact,
          scope: localScope,
          verification,
          verificationWaived: waived && verification.length === 0
        }
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
