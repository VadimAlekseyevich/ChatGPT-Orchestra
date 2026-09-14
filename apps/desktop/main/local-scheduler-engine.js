"use strict";

const FATAL_GIT_REASONS = new Set([
  "target_branch_moved",
  "git_provider_auth_required",
  "git_provider_rate_limited",
  "git_provider_network_error",
  "git_provider_unavailable",
  "git_repository_identity_missing",
  "git_repository_or_ref_unavailable",
  "git_default_branch_missing",
  "git_base_snapshot_missing",
  "git_changed_files_may_be_truncated"
]);

function isReplayableLocalCompletion(record, run) {
  const event = record?.event;
  return Boolean(
    run
    && event?.event === "DONE"
    && event.runId === run.runId
    && event.taskId === run.taskId
    && event.agentId === run.agentId
    && String(event.payload?.artifactFormat || "") === "file-set-v1"
    && String(event.payload?.workerArtifactSignature || "").startsWith("fnv1a64:")
    && record?.source?.workerArtifact?.format === "file-set-v1"
  );
}

function createLocalSchedulerEngine(BaseSchedulerEngine) {
  if (typeof BaseSchedulerEngine !== "function") throw new TypeError("base_scheduler_engine_required");
  return class LocalSchedulerEngine extends BaseSchedulerEngine {
    async init() {
      const state = await super.init();
      await this.replayPersistedLocalCompletions();
      return this.getPublicState?.() || state;
    }

    async replayPersistedLocalCompletions() {
      const activeRuns = new Map((this.store?.activeRuns?.() || []).map((run) => [run.runId, run]));
      if (!activeRuns.size) return { replayed: 0 };
      const records = this.eventBus?.recent?.(200)?.events || [];
      let replayed = 0;
      for (const record of records) {
        const run = activeRuns.get(record?.event?.runId);
        if (!isReplayableLocalCompletion(record, run)) continue;
        await this.store.logDecision?.("local_worker_completion_replayed", {
          taskId: run.taskId,
          runId: run.runId,
          eventId: record.event.eventId || null,
          cursor: record.cursor || null
        });
        await this.handleCompletion(record);
        activeRuns.delete(run.runId);
        replayed += 1;
      }
      return { replayed };
    }

    async handleCompletion(record) {
      const run = this.matchesActiveRun(record);
      if (!run || record.event.event !== "DONE") return;
      const task = this.store.getTask(run.taskId);
      const project = this.projectStore.getActiveProject();
      const definition = task?.definition || task;

      if (run.git?.required !== false) {
        const validation = this.gitProvider?.validateArtifact
          ? await this.gitProvider.validateArtifact({
            project,
            task: definition,
            run,
            snapshot: this.store.getGitSnapshot?.(),
            payload: record.event.payload || {},
            source: record.source || null
          })
          : { ok: false, reason: "git_provider_unavailable" };
        await this.store.recordArtifactValidation?.(run.runId, validation);

        if (!validation.ok) {
          const gitReason = String(validation.reason || "artifact_invalid");
          const fatal = FATAL_GIT_REASONS.has(gitReason) || gitReason.startsWith("git_provider_");
          const result = await this.store.markFailure(run.runId, "artifact_invalid", { retryable: !fatal, needsUser: fatal });
          await this.registry.clearProtocolContext(run.agentId);
          await this.store.logDecision("git_artifact_invalid", {
            taskId: run.taskId,
            runId: run.runId,
            agentId: run.agentId,
            branch: run.git?.branch || null,
            reason: gitReason,
            fatal,
            validation
          });
          if (fatal || result?.task?.status === "NEEDS_USER") await this.escalate(gitReason, result?.task || task, validation);
          else await this.tick({ reason: "artifact_invalid_retry" });
          return;
        }

        await this.store.logDecision("git_artifact_valid", {
          taskId: run.taskId,
          runId: run.runId,
          agentId: run.agentId,
          branch: validation.artifact?.branch,
          commit: validation.artifact?.commit,
          changedFiles: validation.artifact?.changedFiles || [],
          localOnly: validation.artifact?.localOnly === true
        });
      }

      const workerReport = { ...(record.event.payload || {}) };
      const done = await this.store.markDone(run.runId, workerReport);
      if (!done || done.ok === false) {
        await this.escalate(done?.reason || "task_completion_persistence_failed", task, done || null);
        return;
      }
      await this.registry.clearProtocolContext(run.agentId);
      await this.store.logDecision("task_done_by_worker", {
        taskId: run.taskId,
        runId: run.runId,
        agentId: run.agentId,
        artifact: done.task?.lastArtifact || null
      });

      if (!this.reviewEngine) {
        await this.escalate("review_engine_unavailable", done.task);
        return;
      }
      const queued = await this.reviewEngine.enqueueForWorkerCompletion({ task: done.task, run: done.run, workerReport });
      if (!queued?.ok) {
        await this.escalate(queued?.reason || "review_enqueue_failed", done.task, queued || null);
        return;
      }
      await this.tick({ reason: "worker_done_review_queued" });
    }
  };
}

module.exports = { createLocalSchedulerEngine, FATAL_GIT_REASONS, isReplayableLocalCompletion };
