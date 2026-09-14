"use strict";

const WorkerArtifactParser = require("../../../content/worker-artifact-parser.js");

function createLocalOrchestrator(BaseOrchestrator) {
  if (typeof BaseOrchestrator !== "function") throw new TypeError("base_orchestrator_required");
  return class LocalOrchestrator extends BaseOrchestrator {
    async handleProtocolEvent(message, sender) {
      if (!this.eventBus) return { ok: false, reason: "event_bus_unavailable" };
      const payload = message?.payload || {};
      const event = payload.event || null;
      const workerArtifact = payload.workerArtifact || null;
      const expectsWorkerArtifact = event?.event === "DONE" && String(event?.payload?.artifactFormat || "") === "file-set-v1";

      if (expectsWorkerArtifact) {
        if (!workerArtifact) {
          return this.eventBus.reject?.("worker_artifact_missing", { event, sender: this.senderContext(sender) })
            || { ok: false, reason: "worker_artifact_missing" };
        }
        const expectedSignature = String(event?.payload?.workerArtifactSignature || "").trim();
        if (!expectedSignature) {
          return this.eventBus.reject?.("worker_artifact_signature_missing", { event, sender: this.senderContext(sender) })
            || { ok: false, reason: "worker_artifact_signature_missing" };
        }
        const actualSignature = WorkerArtifactParser.artifactSignature(workerArtifact);
        if (actualSignature !== expectedSignature) {
          return this.eventBus.reject?.("worker_artifact_signature_mismatch", {
            event,
            sender: this.senderContext(sender),
            details: { expectedSignature, actualSignature }
          }) || { ok: false, reason: "worker_artifact_signature_mismatch" };
        }
      } else if (workerArtifact) {
        return this.eventBus.reject?.("worker_artifact_unexpected", { event, sender: this.senderContext(sender) })
          || { ok: false, reason: "worker_artifact_unexpected" };
      }

      return this.eventBus.handleEvent(event, this.senderContext(sender), {
        responseFingerprint: payload.responseFingerprint || "",
        pathname: payload.pathname || "",
        messageCount: payload.messageCount || 0,
        planningArtifact: payload.planningArtifact || null,
        planningArtifactSignature: payload.planningArtifactSignature || "",
        workerArtifact,
        workerArtifactSignature: payload.workerArtifactSignature || ""
      });
    }
  };
}

module.exports = { createLocalOrchestrator };
