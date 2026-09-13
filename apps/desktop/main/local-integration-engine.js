"use strict";

function createLocalIntegrationEngine(BaseIntegrationEngine) {
  if (typeof BaseIntegrationEngine !== "function") throw new TypeError("base_integration_engine_required");

  return class LocalIntegrationEngine extends BaseIntegrationEngine {
    constructor(options = {}) {
      super(options);
      this.localIntegrationCoordinator = options.localIntegrationCoordinator || null;
    }

    isLocalProject(project) {
      return Boolean(project?.repositoryRuntime?.repositoryId && this.localIntegrationCoordinator);
    }

    async completeLocalRun(project, runSpec, local, { recovered = false } = {}) {
      const repositoryId = project.repositoryRuntime.repositoryId;
      const result = {
        ...local.result,
        targetPolicy: this.store.summary().settings.targetPolicy,
        targetBranchUnmodified: true,
        localValidation: {
          ok: true,
          repositoryId,
          workspaceId: local.workspaceId,
          mergeCount: local.merges?.length || 0,
          recovered: recovered || local.recovered === true
        }
      };
      await this.store.complete(runSpec.runId, result);
      await this.schedulerStore.setStatus("INTEGRATION_VERIFIED");
      await this.projectStore.setExecutionStatus?.(project.projectId, "INTEGRATION_VERIFIED", { phase: 17, integration: result });
      await this.schedulerStore.logDecision(recovered ? "integration_recovered_local" : "integration_verified_local", {
        runId: runSpec.runId,
        branch: result.branch,
        commit: result.commit,
        mergeOrder: result.mergedTaskIds,
        workspaceId: local.workspaceId,
        targetPolicy: result.targetPolicy
      });
      return { ok: true, local: true, recovered, run: this.store.currentRun(), result };
    }

    async runLocalIntegration(project, tasks, runSpec, { recovered = false, allowFallback = true } = {}) {
      let local;
      try {
        local = await this.localIntegrationCoordinator.integrate({ project, tasks, runSpec });
      } catch (error) {
        local = { ok: false, reason: "local_integration_runtime_error", error: String(error?.message || error) };
      }
      if (local?.ok) return this.completeLocalRun(project, runSpec, local, { recovered });

      const fallbackReasons = new Set(["local_integration_merge_conflict", "local_integration_verification_failed"]);
      if (fallbackReasons.has(local?.reason)) {
        await this.store.abandon(runSpec.runId, local.reason);
        await this.schedulerStore.setStatus("READY_FOR_INTEGRATION");
        await this.projectStore.setExecutionStatus?.(project.projectId, "READY_FOR_INTEGRATION", {
          phase: 17,
          reason: "local_integration_requires_ai_repair",
          localIntegration: local
        });
        await this.schedulerStore.logDecision("local_integration_fallback", {
          runId: runSpec.runId,
          reason: local.reason,
          currentTaskId: local.currentTaskId || null,
          mergedTaskIds: local.mergedTaskIds || [],
          files: local.files || [],
          recovered
        });
        return allowFallback ? super.startNewRun(project, tasks) : { ok: true, pendingFallback: true, reason: local.reason };
      }

      return this.escalate(local?.reason || "local_integration_failed", local || null);
    }

    async restoreActiveRun() {
      const run = this.store.currentRun();
      const project = this.projectStore.getActiveProject?.() || null;
      if (!run || !this.isLocalProject(project) || run.agentId || !["PENDING", "RUNNING"].includes(run.status)) {
        return super.restoreActiveRun();
      }

      const freshness = await this.ensureTargetFresh(project);
      if (!freshness.ok) return this.escalate(freshness.reason || "integration_target_not_fresh", freshness);
      const tasks = this.schedulerStore.listTasks().filter((task) => task.status === "APPROVED");
      if (!tasks.length || tasks.length !== (run.taskOrder || []).length) {
        return this.escalate("local_integration_recovery_tasks_missing", { runId: run.runId, expectedTaskIds: run.taskOrder || [], availableTaskIds: tasks.map((task) => task.id) });
      }
      await this.schedulerStore.logDecision("local_integration_recovery_started", { runId: run.runId, branch: run.branch });
      return this.runLocalIntegration(project, tasks, run, { recovered: true, allowFallback: false });
    }

    async startNewRun(project, tasks) {
      if (!this.isLocalProject(project)) return super.startNewRun(project, tasks);

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
        repositoryId: project.repositoryRuntime.repositoryId,
        branch: built.spec.branch,
        mergeOrder: built.spec.mergeTaskIds
      });
      return this.runLocalIntegration(project, tasks, built.spec, { recovered: false, allowFallback: true });
    }
  };
}

module.exports = { createLocalIntegrationEngine };
