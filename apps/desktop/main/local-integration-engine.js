"use strict";

function createLocalIntegrationEngine(BaseIntegrationEngine) {
  if (typeof BaseIntegrationEngine !== "function") throw new TypeError("base_integration_engine_required");

  return class LocalIntegrationEngine extends BaseIntegrationEngine {
    constructor(options = {}) {
      super(options);
      this.localIntegrationCoordinator = options.localIntegrationCoordinator || null;
    }

    async startNewRun(project, tasks) {
      const repositoryId = project?.repositoryRuntime?.repositoryId || null;
      if (!repositoryId || !this.localIntegrationCoordinator) return super.startNewRun(project, tasks);

      const freshness = await this.ensureTargetFresh(project);
      if (!freshness.ok) return this.escalate(freshness.reason || "integration_target_not_fresh", freshness);
      const built = this.buildRunSpec(project, tasks);
      if (!built.ok) return this.escalate(built.reason, built);

      const created = await this.store.createRun(built.spec);
      if (!created.ok) return created;
      await this.store.markRunning(built.spec.runId);
      await this.schedulerStore.setStatus("INTEGRATING");
      await this.projectStore.setExecutionStatus?.(project.projectId, "INTEGRATING", {
        phase: 17,
        reason: "local_integration_started",
        integration: {
          runId: built.spec.runId,
          branch: built.spec.branch,
          baseSha: built.spec.baseSha,
          targetBranch: built.spec.targetBranch,
          mergeOrder: built.spec.mergeTaskIds,
          runtime: "local-worktree"
        }
      });
      await this.schedulerStore.logDecision("local_integration_started", {
        runId: built.spec.runId,
        repositoryId,
        branch: built.spec.branch,
        mergeOrder: built.spec.mergeTaskIds
      });

      let local;
      try {
        local = await this.localIntegrationCoordinator.integrate({ project, tasks, runSpec: built.spec });
      } catch (error) {
        local = { ok: false, reason: "local_integration_runtime_error", error: String(error?.message || error) };
      }

      if (local?.ok) {
        const result = {
          ...local.result,
          targetPolicy: this.store.summary().settings.targetPolicy,
          targetBranchUnmodified: true,
          localValidation: {
            ok: true,
            repositoryId,
            workspaceId: local.workspaceId,
            mergeCount: local.merges?.length || 0
          }
        };
        await this.store.complete(built.spec.runId, result);
        await this.schedulerStore.setStatus("INTEGRATION_VERIFIED");
        await this.projectStore.setExecutionStatus?.(project.projectId, "INTEGRATION_VERIFIED", { phase: 17, integration: result });
        await this.schedulerStore.logDecision("integration_verified_local", {
          runId: built.spec.runId,
          branch: result.branch,
          commit: result.commit,
          mergeOrder: result.mergedTaskIds,
          workspaceId: local.workspaceId,
          targetPolicy: result.targetPolicy
        });
        return { ok: true, local: true, run: this.store.currentRun(), result };
      }

      const fallbackReasons = new Set([
        "local_integration_merge_conflict",
        "local_integration_verification_failed"
      ]);
      if (fallbackReasons.has(local?.reason)) {
        await this.store.abandon(built.spec.runId, local.reason);
        await this.schedulerStore.setStatus("READY_FOR_INTEGRATION");
        await this.projectStore.setExecutionStatus?.(project.projectId, "READY_FOR_INTEGRATION", {
          phase: 17,
          reason: "local_integration_requires_ai_repair",
          localIntegration: local
        });
        await this.schedulerStore.logDecision("local_integration_fallback", {
          runId: built.spec.runId,
          reason: local.reason,
          currentTaskId: local.currentTaskId || null,
          mergedTaskIds: local.mergedTaskIds || [],
          files: local.files || []
        });
        return super.startNewRun(project, tasks);
      }

      return this.escalate(local?.reason || "local_integration_failed", local || null);
    }
  };
}

module.exports = { createLocalIntegrationEngine };
