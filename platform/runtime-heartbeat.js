(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};
  const Lifecycle = root.AgentLifecycle || (typeof require === "function" ? require("./agent-lifecycle.js") : null);

  function normalizeRuntimeHeartbeat(payload = {}, { bindingPresent = true } = {}) {
    if (!bindingPresent) return { state: Lifecycle.STATES.UNAVAILABLE, reason: "session_missing", legacyStatus: "OFFLINE" };
    const availability = String(payload.availability || "unknown");
    const reason = String(payload.reason || payload.error || "");

    if (payload.terminal === true) {
      return {
        state: Lifecycle.STATES.FAILED,
        reason: reason === "runtime_incompatible" ? "runtime_incompatible" : "runtime_failure",
        legacyStatus: "ERROR"
      };
    }
    if (payload.generating === true || availability === "generating") {
      return { state: Lifecycle.STATES.BUSY, reason: "prompt_active", legacyStatus: "BUSY" };
    }
    if (availability === "ready") {
      if (payload.composerOccupied === true) {
        return { state: Lifecycle.STATES.UNAVAILABLE, reason: "composer_unavailable", legacyStatus: "ERROR" };
      }
      return { state: Lifecycle.STATES.READY, reason: "prompt_ready", legacyStatus: "IDLE" };
    }
    if (reason === "login_required" || availability === "login_required") {
      return { state: Lifecycle.STATES.UNAVAILABLE, reason: "login_required", legacyStatus: "ERROR" };
    }
    if (reason === "heartbeat_stale") {
      return { state: Lifecycle.STATES.UNAVAILABLE, reason: "heartbeat_stale", legacyStatus: "ERROR" };
    }
    if (availability === "error" || availability === "unavailable") {
      return { state: Lifecycle.STATES.UNAVAILABLE, reason: "page_unreachable", legacyStatus: "ERROR" };
    }
    return { state: Lifecycle.STATES.UNAVAILABLE, reason: "runtime_starting", legacyStatus: "CONNECTING" };
  }

  root.RuntimeHeartbeat = { normalizeRuntimeHeartbeat };
  if (typeof module !== "undefined" && module.exports) module.exports = root.RuntimeHeartbeat;
})();
