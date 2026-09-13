(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};
  if (root.__recoveryStopGuardsInstalled) return;
  root.__recoveryStopGuardsInstalled = true;

  function stopping() {
    const status = root.RecoveryRuntime?.controller?.getPublicState?.()?.status;
    return status === "STOPPING" || status === "STOPPED";
  }

  function guard(proto, methodName) {
    if (!proto || typeof proto[methodName] !== "function") return;
    const original = proto[methodName];
    proto[methodName] = async function stopBoundaryGuard(...args) {
      if (stopping()) return { ok: true, ignored: true, reason: "stop_boundary_active" };
      return original.apply(this, args);
    };
  }

  guard(root.PlanningEngine?.prototype, "handleCompletion");
  guard(root.PlanningEngine?.prototype, "handleBlocker");

  guard(root.SchedulerEngine?.prototype, "handleCompletion");
  guard(root.SchedulerEngine?.prototype, "handleBlocker");
  guard(root.SchedulerEngine?.prototype, "handleNeedsUser");

  guard(root.ReviewEngine?.prototype, "handleReviewEvent");
  guard(root.ReviewEngine?.prototype, "handleReviewFailureEvent");

  guard(root.IntegrationEngine?.prototype, "handleCompletion");
  guard(root.IntegrationEngine?.prototype, "handleIntegrationEvent");
  guard(root.IntegrationEngine?.prototype, "handleFailureEvent");
})();
