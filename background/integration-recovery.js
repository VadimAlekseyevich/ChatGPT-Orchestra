(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};
  const BaseIntegrationEngine = root.IntegrationEngine;
  if (!BaseIntegrationEngine) throw new Error("integration_engine_required_before_recovery_policy");

  class RecoverableIntegrationEngine extends BaseIntegrationEngine {
    async restoreActiveRun() {
      const run = this.store.currentRun();
      if (!run) return;

      // ASSIGNED means persistence happened before we can prove prompt delivery.
      // REPAIR_PENDING means a repair task exists but delivery may not have happened.
      // Never replay either prompt after an MV3 restart: abandon the unique branch/run
      // and create a fresh identity. Late events from the abandoned run are rejected by
      // the newly bound protocol context and can only affect the abandoned integration branch.
      if (["ASSIGNED", "REPAIR_PENDING"].includes(run.status)) {
        if (run.agentId) await this.registry.clearProtocolContext(run.agentId);
        await this.store.abandon(run.runId, `ambiguous_restart_${run.status.toLowerCase()}`);
        await this.schedulerStore.setStatus("READY_FOR_INTEGRATION");
        const projectId = this.store.summary().projectId || this.projectStore.getActiveProject()?.projectId;
        if (projectId) {
          await this.projectStore.setExecutionStatus?.(projectId, "READY_FOR_INTEGRATION", {
            phase: 8,
            reason: "integration_ambiguous_restart_replaced",
            abandonedRunId: run.runId,
            abandonedStatus: run.status
          });
        }
        return;
      }

      return super.restoreActiveRun();
    }
  }

  root.RecoverableIntegrationEngine = RecoverableIntegrationEngine;
  if (typeof module !== "undefined" && module.exports) module.exports = { RecoverableIntegrationEngine };
})();
