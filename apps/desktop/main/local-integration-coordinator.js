"use strict";

const { normalizeLocalVerificationPlan, requiresLocalVerification } = require("../../../platform/local-verification.js");

function stableCommandKey(command) {
  return JSON.stringify([command.command, command.args || [], command.timeoutMs || null]);
}

function localIntegrationVerificationPlan(tasks = []) {
  const commands = [];
  const seen = new Set();
  for (const task of tasks) {
    const definition = task?.definition || task || {};
    const waived = Boolean(String(definition.verificationWaiver || "").trim());
    const normalized = normalizeLocalVerificationPlan(definition.localVerification, {
      required: requiresLocalVerification(definition) && !waived
    });
    if (!normalized.ok) return { ok: false, reason: normalized.reason, taskId: String(task?.id || definition.id || ""), commands: [] };
    for (const command of normalized.commands) {
      const key = stableCommandKey(command);
      if (seen.has(key)) continue;
      seen.add(key);
      commands.push(command);
    }
  }
  return { ok: true, commands };
}

class LocalIntegrationCoordinator {
  constructor({ repositoryService, clock = () => Date.now(), logger = console } = {}) {
    if (!repositoryService) throw new TypeError("local_integration_repository_service_required");
    this.repositoryService = repositoryService;
    this.clock = clock;
    this.logger = logger;
  }

  async ensureWorkspace({ projectId, repositoryId, runId, baseSha }) {
    try {
      const created = await this.repositoryService.createIntegrationWorkspace({ projectId, repositoryId, runId, startSha: baseSha });
      const workspaceId = created?.workspace?.workspaceId;
      if (!created?.ok || !workspaceId) return { ok: false, reason: "local_integration_workspace_create_failed", created };
      return { ok: true, workspaceId, recovered: false };
    } catch (error) {
      if (String(error?.message || "") !== "git_workspace_already_exists") throw error;
      const workspaceId = `integration:${runId}`;
      const status = await this.repositoryService.workspaceStatus({ projectId, repositoryId, workspaceId });
      if (!status?.ok || !status?.status) return { ok: false, reason: "local_integration_workspace_recovery_failed", workspaceId, status };
      return { ok: true, workspaceId, recovered: true };
    }
  }

  async integrate({ project, tasks = [], runSpec } = {}) {
    const repositoryId = project?.repositoryRuntime?.repositoryId || null;
    if (!repositoryId) return { ok: false, reason: "local_integration_repository_binding_missing" };
    if (!runSpec?.runId || !runSpec?.baseSha) return { ok: false, reason: "local_integration_run_spec_invalid" };

    const plan = localIntegrationVerificationPlan(tasks);
    if (!plan.ok) return { ok: false, reason: "local_integration_verification_plan_invalid", details: plan };

    let ensured;
    try {
      ensured = await this.ensureWorkspace({ projectId: project.projectId, repositoryId, runId: runSpec.runId, baseSha: runSpec.baseSha });
    } catch (error) {
      return { ok: false, reason: "local_integration_workspace_create_failed", error: String(error?.message || error) };
    }
    if (!ensured.ok) return ensured;
    const { workspaceId, recovered } = ensured;

    const mergedTaskIds = [];
    const merges = [];
    for (const artifact of runSpec.artifacts || []) {
      let merged;
      try {
        merged = await this.repositoryService.mergeTaskArtifact({
          projectId: project.projectId,
          repositoryId,
          integrationWorkspaceId: workspaceId,
          taskCommit: artifact.commit,
          message: `Integrate approved task ${artifact.taskId}`
        });
      } catch (error) {
        return {
          ok: false,
          reason: "local_integration_merge_failed",
          conflict: false,
          workspaceId,
          currentTaskId: artifact.taskId,
          mergedTaskIds,
          error: String(error?.message || error)
        };
      }
      const merge = merged?.merge || merged;
      if (!merged?.ok || !merge?.ok) {
        const conflict = merge?.reason === "git_merge_conflict";
        return {
          ok: false,
          reason: conflict ? "local_integration_merge_conflict" : (merge?.reason || "local_integration_merge_failed"),
          conflict,
          workspaceId,
          currentTaskId: artifact.taskId,
          mergedTaskIds,
          files: merge?.files || [],
          merge
        };
      }
      mergedTaskIds.push(artifact.taskId);
      merges.push({ taskId: artifact.taskId, taskCommit: artifact.commit, head: merge.head, alreadyIntegrated: merge.alreadyIntegrated === true });
    }

    const checks = [];
    for (let index = 0; index < plan.commands.length; index += 1) {
      const command = plan.commands[index];
      let checked;
      try {
        checked = await this.repositoryService.verifyWorkspace({
          projectId: project.projectId,
          repositoryId,
          workspaceId,
          command: command.command,
          args: command.args,
          timeoutMs: command.timeoutMs,
          runId: `integration-verify:${runSpec.runId}:${index + 1}`
        });
      } catch (error) {
        if (String(error?.message || "") === "repository_execution_not_trusted") {
          return { ok: false, reason: "local_integration_repository_execution_not_trusted", workspaceId, mergedTaskIds, checks };
        }
        throw error;
      }
      const result = checked?.verification || null;
      checks.push({
        command: command.command,
        argCount: command.args.length,
        label: command.label || null,
        status: result?.ok ? "PASS" : "FAIL",
        evidence: result?.ok ? "local command exited successfully" : `local command ${result?.status || "failed"}`,
        result
      });
      if (!checked?.ok || !result?.ok) return { ok: false, reason: "local_integration_verification_failed", workspaceId, mergedTaskIds, checks };
    }

    const artifactResult = await this.repositoryService.workspaceArtifact({ projectId: project.projectId, repositoryId, workspaceId });
    const artifact = artifactResult?.artifact;
    if (!artifactResult?.ok || !artifact?.head || artifact.clean !== true) return { ok: false, reason: "local_integration_artifact_invalid", workspaceId, artifact };

    return {
      ok: true,
      workspaceId,
      repositoryId,
      recovered,
      result: {
        branch: artifact.branch,
        commit: artifact.head,
        baseSha: runSpec.baseSha,
        targetBranch: runSpec.targetBranch,
        mergedTaskIds,
        changedFiles: artifact.changedFiles || [],
        checks,
        summary: "Approved task artifacts were merged deterministically and verified in the local integration worktree.",
        localWorkspaceId: workspaceId,
        recoveredWorkspace: recovered,
        verifiedAt: this.clock(),
        targetBranchUnmodified: true
      },
      merges
    };
  }
}

module.exports = { LocalIntegrationCoordinator, localIntegrationVerificationPlan, stableCommandKey };
