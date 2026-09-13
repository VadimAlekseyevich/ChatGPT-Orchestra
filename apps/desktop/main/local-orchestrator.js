"use strict";

function createLocalOrchestrator(BaseOrchestrator) {
  if (typeof BaseOrchestrator !== "function") throw new TypeError("base_orchestrator_required");
  return class LocalOrchestrator extends BaseOrchestrator {
    async handleProtocolEvent(message, sender) {
      if (!this.eventBus) return { ok: false, reason: "event_bus_unavailable" };
      const payload = message?.payload || {};
      return this.eventBus.handleEvent(payload.event, this.senderContext(sender), {
        responseFingerprint: payload.responseFingerprint || "",
        pathname: payload.pathname || "",
        messageCount: payload.messageCount || 0,
        planningArtifact: payload.planningArtifact || null,
        planningArtifactSignature: payload.planningArtifactSignature || "",
        workerArtifact: payload.workerArtifact || null,
        workerArtifactSignature: payload.workerArtifactSignature || ""
      });
    }
  };
}

module.exports = { createLocalOrchestrator };
