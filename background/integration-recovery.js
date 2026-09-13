(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};
  const BaseIntegrationEngine = root.IntegrationEngine;
  if (!BaseIntegrationEngine) throw new Error("integration_engine_required_before_recovery_policy");

  class RecoverableIntegrationEngine extends BaseIntegrationEngine {
    async restoreActiveRun() {
      const run = this.store.currentRun();
      if (!run) return;

      // ASSIGNED means persistence happened before prompt delivery is proven.
      // REPAIR_PENDING means the repair exists, but the repair prompt may or may not
      // have been delivered. CONFLICT means the conflict event was persisted but the
      // repair transaction did not finish. Never replay these ambiguous boundaries
      // after an MV3 restart: abandon the unique branch/run and create a fresh identity.
      // Late events from the abandoned run are rejected by the newly bound context.
      if (["ASSIGNED", "REPAIR_PENDING", "CONFLICT"].includes(run.status)) {
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
