"use strict";

const {
  requiresLocalVerification,
  normalizeLocalVerificationPlan
} = require("../../../platform/local-verification.js");
const { normalizeLocalChangeSet } = require("../../../platform/local-change-set.js");

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

  async reviewComparison(project, artifact) {
    if (artifact?.localOnly === true && artifact?.repositoryId && artifact?.workspaceId) {
      return this.repositoryService.workspaceReviewComparison({ projectId: project?.projectId, repositoryId: artifact.repositoryId, workspaceId: artifact.workspaceId });
    }
    return this.remoteProvider.compare(project, artifact?.baseSha, artifact?.commit);
  }

  async ensureTaskWorkspace({ project, task, run, snapshot = null } = {}) {
    const repositoryId = project?.repositoryRuntime?.repositoryId || null;
    if (!repositoryId || run?.git?.required === false) return { ok: true, skipped: true, reason: repositoryId ? "git_artifact_not_required" : "local_repository_not_bound" };
    if (!project?.projectId || !task?.id || !run?.runId) return { ok: false, reason: "local_run_identity_missing" };
    const workspaceId = `task:${task.id}:${run.runId}`;
    try {
      const created = await this.repositoryService.createTaskWorkspace({ projectId: project.projectId, repositoryId, taskId: task.id, runId: run.runId, startSha: run.git?.startSha || run.git?.baseSha || snapshot?.baseSha || "HEAD" });
      return { ok: true, workspaceId: created?.workspace?.workspaceId || workspaceId, created: true, repositoryId };
    } catch (error) {
      if (String(error?.message || "") !== "git_workspace_already_exists") return { ok: false, reason: "local_workspace_create_failed", error: String(error?.message || error), repositoryId };
      const status = await this.repositoryService.workspaceStatus({ projectId: project.projectId, repositoryId, workspaceId });
      if (!status?.ok) return { ok: false, reason: "local_workspace_recovery_failed", workspaceId, repositoryId };
      return { ok: true, workspaceId, created: false, recovered: true, repositoryId };
    }
  }

  async prepareRun(input = {}) {
    const prepared = await this.ensureTaskWorkspace(input);
    if (!prepared.ok) this.logger?.warn?.("local_task_workspace_prepare_failed", { projectId: input.project?.projectId || null, taskId: input.task?.id || null, runId: input.run?.runId || null, reason: prepared.reason });
    return prepared;
  }

  verificationPlan(task) {
    const waived = Boolean(String(task?.verificationWaiver || "").trim());
    const plan = normalizeLocalVerificationPlan(task?.localVerification, { required: requiresLocalVerification(task) && !waived });
    return { waived, plan };
  }

  async verifyPreparedWorkspace({ project, task, run, repositoryId, workspaceId, localArtifact = null, localScope = null } = {}) {
    const { waived, plan } = this.verificationPlan(task);
    if (!plan.ok) return { ok: false, reason: "git_provider_local_verification_plan_invalid", local: { ok: false, reason: plan.reason, verificationPlan: plan } };
    const verification = [];
    for (let index = 0; index < plan.commands.length; index += 1) {
      const command = plan.commands[index];
      let checked;
      try {
        checked = await this.repositoryService.verifyWorkspace({ projectId: project.projectId, repositoryId, workspaceId, command: command.command, args: command.args, timeoutMs: command.timeoutMs, runId: `local-verify:${run.runId}:${index + 1}` });
      } catch (error) {
        if (String(error?.message || "") === "repository_execution_not_trusted") {
          return { ok: false, reason: "git_provider_repository_execution_not_trusted", local: { ok: false, reason: "repository_execution_not_trusted", workspaceId, artifact: localArtifact, scope: localScope, verification } };
        }
        throw error;
      }
      const result = checked?.verification || null;
      verification.push({ index, label: command.label || null, command: command.command, argCount: command.args.length, result });
      if (!checked?.ok || !result?.ok) return { ok: false, reason: "local_verification_failed", local: { ok: false, reason: "local_verification_failed", workspaceId, artifact: localArtifact, scope: localScope, verification } };
    }
    return { ok: true, verification, verificationWaived: waived && verification.length === 0 };
  }

  workerChangeArtifact(input = {}) {
    return input.source?.workerArtifact || input.payload?.localChanges || null;
  }

  async validateLocalChangeArtifact(input, { project, task, run, repositoryId } = {}) {
    const normalized = normalizeLocalChangeSet(this.workerChangeArtifact(input));
    if (!normalized.ok) return { ok: false, reason: normalized.reason, local: { ok: false, reason: normalized.reason } };
    const freshness = this.remoteProvider?.checkBaseFresh && input.snapshot
      ? await this.remoteProvider.checkBaseFresh(project, input.snapshot)
      : { ok: true, currentTargetSha: input.snapshot?.baseSha || null };
    if (!freshness?.ok) return freshness;

    const prepared = await this.ensureTaskWorkspace({ project, task, run, snapshot: input.snapshot });
    if (!prepared.ok) return { ok: false, reason: "git_repository_or_ref_unavailable", local: { ok: false, reason: prepared.reason, error: prepared.error || null } };
    const workspaceId = prepared.workspaceId;

    try {
      const applied = await this.repositoryService.applyWorkerChanges({ projectId: project.projectId, repositoryId, workspaceId, changeSet: normalized.changeSet });
      if (!applied?.ok) return { ok: false, reason: applied?.reason || "local_change_set_apply_failed", local: { ok: false, workspaceId, applied } };
      const scope = await this.repositoryService.workspaceScope({ projectId: project.projectId, repositoryId, workspaceId, allowedPaths: task.scope?.allow || [] });
      if (!scope?.scope?.ok) return { ok: false, reason: "local_scope_violation", local: { ok: false, workspaceId, scope: scope?.scope || null } };

      const verified = await this.verifyPreparedWorkspace({ project, task, run, repositoryId, workspaceId, localScope: scope.scope });
      if (!verified.ok) return verified;
      const committed = await this.repositoryService.commitWorkspace({ projectId: project.projectId, repositoryId, workspaceId, message: `Orchestra task ${task.id} run ${run.runId}` });
      const commit = committed?.commit;
      if (!committed?.ok || !commit?.sha) return { ok: false, reason: commit?.reason || committed?.reason || "local_commit_failed", local: { ok: false, workspaceId, committed } };
      const artifactState = await this.repositoryService.workspaceArtifact({ projectId: project.projectId, repositoryId, workspaceId });
      const artifact = artifactState?.artifact;
      if (!artifactState?.ok || !artifact?.head || artifact.clean !== true) return { ok: false, reason: "local_commit_validation_failed", local: { ok: false, workspaceId, artifact } };
      if (artifact.head.toLowerCase() !== commit.sha.toLowerCase()) return { ok: false, reason: "local_commit_head_mismatch", local: { ok: false, workspaceId, expected: commit.sha, actual: artifact.head } };

      return {
        ok: true,
        freshness,
        artifact: {
          branch: artifact.branch,
          commit: artifact.head.toLowerCase(),
          baseSha: run.git?.baseSha || input.snapshot?.baseSha || "",
          targetBranch: run.git?.targetBranch || input.snapshot?.defaultBranch || "",
          changedFiles: artifact.changedFiles || [],
          workspaceId,
          repositoryId,
          localOnly: true,
          localVerificationPassed: true,
          changeSetFormat: normalized.changeSet.format
        },
        local: { ok: true, workspaceId, scope: scope.scope, verification: verified.verification, verificationWaived: verified.verificationWaived, changeSet: applied.summary || null }
      };
    } catch (error) {
      this.logger?.warn?.("local_change_artifact_validation_failed", { projectId: project.projectId, taskId: task.id, runId: run.runId, repositoryId, error: String(error?.message || error) });
      return { ok: false, reason: String(error?.message || "local_change_artifact_validation_failed"), local: { ok: false, workspaceId, reason: "local_change_artifact_validation_failed" } };
    }
  }

  async validateArtifact(input = {}) {
    const project = input.project || null;
    const task = input.task || null;
    const run = input.run || null;
    const repositoryId = project?.repositoryRuntime?.repositoryId || null;
    if (repositoryId && this.workerChangeArtifact(input)) return this.validateLocalChangeArtifact(input, { project, task, run, repositoryId });

    const remote = await this.remoteProvider.validateArtifact(input);
    if (!remote?.ok) return remote;
    if (!repositoryId) return remote;
    if (!task?.id || !run?.runId) return { ok: false, reason: "git_repository_identity_missing", remote, local: { ok: false, reason: "local_run_identity_missing" } };

    const { plan } = this.verificationPlan(task);
    if (!plan.ok) return { ok: false, reason: "git_provider_local_verification_plan_invalid", remote, local: { ok: false, reason: plan.reason, verificationPlan: plan } };
    const prepared = await this.ensureTaskWorkspace({ project, task, run, snapshot: input.snapshot });
    if (!prepared.ok) return { ok: false, reason: "git_repository_or_ref_unavailable", remote, local: { ok: false, reason: prepared.reason, error: prepared.error || null } };
    const workspaceId = prepared.workspaceId;

    try {
      const materialized = await this.repositoryService.materializeTaskArtifact({ projectId: project.projectId, repositoryId, workspaceId, commit: remote.artifact?.commit, branch: remote.artifact?.branch || run.git?.branch, remote: "origin" });
      const scope = await this.repositoryService.workspaceScope({ projectId: project.projectId, repositoryId, workspaceId, allowedPaths: task.scope?.allow || [] });
      const localArtifact = materialized?.artifact || null;
      const localScope = scope?.scope || null;
      if (!materialized?.ok || !localArtifact?.head) return { ok: false, reason: "git_repository_or_ref_unavailable", remote, local: { ok: false, reason: "local_artifact_materialize_failed", materialized } };
      if (!localScope?.ok) return { ok: false, reason: "local_scope_violation", remote, local: { ok: false, workspaceId, artifact: localArtifact, scope: localScope } };
      const verified = await this.verifyPreparedWorkspace({ project, task, run, repositoryId, workspaceId, localArtifact, localScope });
      if (!verified.ok) return { ...verified, remote };
      return {
        ...remote,
        artifact: { ...remote.artifact, remoteChangedFiles: remote.artifact?.changedFiles || [], changedFiles: localArtifact.changedFiles || [], workspaceId, repositoryId, localVerificationPassed: true },
        local: { ok: true, workspaceId, artifact: localArtifact, scope: localScope, verification: verified.verification, verificationWaived: verified.verificationWaived }
      };
    } catch (error) {
      this.logger?.warn?.("local_artifact_validation_failed", { projectId: project.projectId, taskId: task.id, runId: run.runId, repositoryId, error: String(error?.message || error) });
      return { ok: false, reason: "git_repository_or_ref_unavailable", remote, local: { ok: false, reason: "local_artifact_validation_failed", workspaceId, error: String(error?.message || error) } };
    }
  }
}

module.exports = { LocalValidatingGitProvider };
