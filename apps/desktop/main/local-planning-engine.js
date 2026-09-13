"use strict";

function createLocalPlanningEngine(BasePlanningEngine) {
  if (typeof BasePlanningEngine !== "function") throw new TypeError("base_planning_engine_required");
  return class LocalPlanningEngine extends BasePlanningEngine {
    async startProject({ goal, repositoryUrl, repositoryId = null } = {}) {
      const lead = this.getLead();
      if (!this.isConnected(lead)) return { ok: false, reason: "lead_not_connected" };
      const created = await this.projectStore.createProject({ goal, repositoryUrl, repositoryId });
      if (!created.ok) return created;
      return this.dispatchStage(created.project.projectId, "DISCOVERY");
    }
  };
}

module.exports = { createLocalPlanningEngine };
