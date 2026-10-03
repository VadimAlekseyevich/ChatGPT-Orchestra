(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};

  const STATES = Object.freeze({
    READY: "READY",
    BUSY: "BUSY",
    UNAVAILABLE: "UNAVAILABLE",
    FAILED: "FAILED"
  });

  const REASONS = Object.freeze([
    "prompt_ready",
    "prompt_active",
    "runtime_starting",
    "session_missing",
    "transport_disconnected",
    "login_required",
    "composer_unavailable",
    "page_unreachable",
    "navigation_in_progress",
    "heartbeat_stale",
    "browser_crashed",
    "session_replaced",
    "runtime_incompatible",
    "runtime_failure",
    "recovery_required",
    "prompt_rejected",
    "session_removed",
    "recovered"
  ]);

  const REASON_SET = new Set(REASONS);
  const STATE_SET = new Set(Object.values(STATES));
  const ALLOWED = Object.freeze({
    [STATES.READY]: new Set([STATES.READY, STATES.BUSY, STATES.UNAVAILABLE, STATES.FAILED]),
    [STATES.BUSY]: new Set([STATES.BUSY, STATES.READY, STATES.UNAVAILABLE, STATES.FAILED]),
    [STATES.UNAVAILABLE]: new Set([STATES.UNAVAILABLE, STATES.READY, STATES.FAILED]),
    [STATES.FAILED]: new Set([STATES.FAILED])
  });

  function clone(value) {
    if (value === undefined) return undefined;
    if (typeof structuredClone === "function") return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }

  function normalizeState(value, fallback = STATES.UNAVAILABLE) {
    const state = String(value || "").toUpperCase();
    return STATE_SET.has(state) ? state : fallback;
  }

  function normalizeReason(value, fallback = "runtime_failure") {
    const reason = String(value || "").trim();
    return REASON_SET.has(reason) ? reason : fallback;
  }

  function defaultReason(state) {
    if (state === STATES.READY) return "prompt_ready";
    if (state === STATES.BUSY) return "prompt_active";
    if (state === STATES.FAILED) return "runtime_failure";
    return "runtime_starting";
  }

  function stateForLegacyStatus(status, { terminal = false } = {}) {
    const legacy = String(status || "").toUpperCase();
    if (legacy === "IDLE") return STATES.READY;
    if (legacy === "BUSY") return STATES.BUSY;
    if (legacy === "ERROR") return terminal ? STATES.FAILED : STATES.UNAVAILABLE;
    return STATES.UNAVAILABLE;
  }

  function terminalLegacyError(agent = {}) {
    if (agent?.lifecycleDetails?.terminal === true) return true;
    return ["runtime_incompatible", "runtime_failure"].includes(String(agent?.lastError || ""));
  }

  function initialReason(agent, state) {
    if (agent?.lifecycleReason && REASON_SET.has(String(agent.lifecycleReason))) return String(agent.lifecycleReason);
    if (state === STATES.FAILED) {
      return String(agent?.lastError || "") === "runtime_incompatible" ? "runtime_incompatible" : "runtime_failure";
    }
    if (state === STATES.UNAVAILABLE) {
      const lastError = String(agent?.lastError || "");
      if (REASON_SET.has(lastError)) return lastError;
      if (!agent?.sessionId && !Number.isInteger(agent?.tabId)) return "session_missing";
      return "runtime_starting";
    }
    return defaultReason(state);
  }

  function initializeAgentLifecycle(agent, { at = Date.now(), readinessCheckedAt = null } = {}) {
    if (!agent || typeof agent !== "object") throw new TypeError("agent_lifecycle_agent_required");
    const state = normalizeState(
      agent.lifecycleState,
      stateForLegacyStatus(agent.status, { terminal: terminalLegacyError(agent) })
    );
    const changedAt = Number(agent.lifecycleChangedAt) || Number(agent.updatedAt) || Number(agent.createdAt) || Number(at) || Date.now();
    agent.lifecycleState = state;
    agent.lifecycleReason = initialReason(agent, state);
    agent.lifecycleChangedAt = changedAt;
    agent.lifecycleDetails = agent.lifecycleDetails && typeof agent.lifecycleDetails === "object"
      ? clone(agent.lifecycleDetails)
      : null;
    if (state === STATES.READY) {
      const checked = Number(agent.readinessCheckedAt) || Number(readinessCheckedAt) || Number(agent.lastSeenAt) || changedAt;
      agent.readinessCheckedAt = checked;
    } else if (!Number.isFinite(Number(agent.readinessCheckedAt))) {
      agent.readinessCheckedAt = null;
    }
    return agent;
  }

  function canTransition(previousState, nextState, { explicitRecovery = false, validated = false } = {}) {
    const previous = normalizeState(previousState);
    const next = normalizeState(nextState);
    if (previous === STATES.FAILED && next === STATES.UNAVAILABLE) return Boolean(explicitRecovery);
    if (previous === STATES.FAILED && next === STATES.READY) return Boolean(explicitRecovery && validated);
    if (previous === STATES.FAILED && next !== STATES.FAILED) return false;
    return Boolean(ALLOWED[previous]?.has(next));
  }

  function transitionAgentLifecycle(agent, nextState, {
    reason = null,
    at = Date.now(),
    details = null,
    explicitRecovery = false,
    validated = false,
    readinessCheckedAt = null,
    legacyStatus = null
  } = {}) {
    initializeAgentLifecycle(agent, { at });
    const previousState = agent.lifecycleState;
    const previousReason = agent.lifecycleReason;
    const state = normalizeState(nextState);
    const normalizedReason = normalizeReason(reason, defaultReason(state));

    if (!canTransition(previousState, state, { explicitRecovery, validated })) {
      return {
        changed: false,
        rejected: true,
        previousState,
        state: previousState,
        reason: previousReason,
        event: null
      };
    }

    if (legacyStatus !== null && legacyStatus !== undefined) agent.status = String(legacyStatus);
    const now = Number(at) || Date.now();
    const stateChanged = previousState !== state;
    const reasonChanged = previousReason !== normalizedReason;

    agent.lifecycleState = state;
    agent.lifecycleReason = normalizedReason;
    if (stateChanged || reasonChanged) agent.lifecycleChangedAt = now;
    if (details !== null && details !== undefined) agent.lifecycleDetails = clone(details);

    if (state === STATES.READY) {
      agent.readinessCheckedAt = Number(readinessCheckedAt) || now;
    }

    const changed = stateChanged || reasonChanged;
    const event = changed ? {
      type: "agent-lifecycle-changed",
      agentId: String(agent.agentId || ""),
      previousState,
      state,
      reason: normalizedReason,
      at: now,
      details: agent.lifecycleDetails ? clone(agent.lifecycleDetails) : null
    } : null;

    return { changed, rejected: false, previousState, state, reason: normalizedReason, event };
  }

  function lifecycleForAgent(agent) {
    if (!agent) return null;
    const copy = clone(agent);
    initializeAgentLifecycle(copy, { at: Date.now() });
    return {
      agentId: String(copy.agentId || ""),
      lifecycleState: copy.lifecycleState,
      lifecycleReason: copy.lifecycleReason,
      lifecycleChangedAt: Number(copy.lifecycleChangedAt) || 0,
      readinessCheckedAt: Number(copy.readinessCheckedAt) || null,
      lastSeenAt: Number(copy.lastSeenAt) || 0,
      lastError: copy.lastError ?? null,
      lifecycleDetails: copy.lifecycleDetails ? clone(copy.lifecycleDetails) : null
    };
  }

  function isReady(agent, { now = Date.now(), readinessTtlMs = 30000 } = {}) {
    if (!agent) return false;
    const copy = clone(agent);
    initializeAgentLifecycle(copy, { at: now });
    if (copy.lifecycleState !== STATES.READY) return false;
    const checkedAt = Number(copy.readinessCheckedAt);
    if (!Number.isFinite(checkedAt) || checkedAt <= 0) return false;
    const ttl = Number(readinessTtlMs);
    if (!Number.isFinite(ttl)) return true;
    return Math.max(0, Number(now) - checkedAt) <= Math.max(0, ttl);
  }

  function isBusy(agent) {
    if (!agent) return false;
    const copy = clone(agent);
    initializeAgentLifecycle(copy, { at: Date.now() });
    return copy.lifecycleState === STATES.BUSY;
  }

  function isAvailable(agent) {
    if (!agent) return false;
    const copy = clone(agent);
    initializeAgentLifecycle(copy, { at: Date.now() });
    return copy.lifecycleState === STATES.READY || copy.lifecycleState === STATES.BUSY;
  }

  function normalizeHeartbeat(payload = {}, { hasBinding = true } = {}) {
    if (!hasBinding) return { state: STATES.UNAVAILABLE, reason: "session_missing", legacyStatus: "OFFLINE" };
    const availability = String(payload.availability || "unknown");
    const reason = String(payload.reason || payload.error || "");
    if (payload.terminal === true) return { state: STATES.FAILED, reason: reason === "runtime_incompatible" ? "runtime_incompatible" : "runtime_failure", legacyStatus: "ERROR" };
    if (payload.generating === true || availability === "generating") {
      return { state: STATES.BUSY, reason: "prompt_active", legacyStatus: "BUSY" };
    }
    if (availability === "ready") {
      if (payload.composerOccupied === true) return { state: STATES.UNAVAILABLE, reason: "composer_unavailable", legacyStatus: "ERROR" };
      return { state: STATES.READY, reason: "prompt_ready", legacyStatus: "IDLE" };
    }
    if (reason === "login_required" || availability === "login_required") return { state: STATES.UNAVAILABLE, reason: "login_required", legacyStatus: "ERROR" };
    if (reason === "heartbeat_stale") return { state: STATES.UNAVAILABLE, reason: "heartbeat_stale", legacyStatus: "ERROR" };
    if (availability === "error" || availability === "unavailable") {
      return { state: STATES.UNAVAILABLE, reason: "page_unreachable", legacyStatus: "ERROR" };
    }
    return { state: STATES.UNAVAILABLE, reason: "runtime_starting", legacyStatus: "CONNECTING" };
  }

  root.AgentLifecycle = {
    STATES,
    REASONS,
    normalizeState,
    normalizeReason,
    stateForLegacyStatus,
    initializeAgentLifecycle,
    canTransition,
    transitionAgentLifecycle,
    lifecycleForAgent,
    isReady,
    isBusy,
    isAvailable,
    normalizeHeartbeat
  };

  if (typeof module !== "undefined" && module.exports) module.exports = root.AgentLifecycle;
})();