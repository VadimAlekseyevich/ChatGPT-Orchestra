(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};
  const CONTRACT_VERSION = 3;

  const AGENT_RUNTIME_METHODS = Object.freeze([
    "load",
    "snapshot",
    "listAgents",
    "getAgent",
    "getAgentBySessionId",
    "isAgentConnected",
    "sessionIdForAgent",
    "runtimeBinding",
    "setRuntimeStatus",
    "setProtocolContext",
    "clearProtocolContext",
    "removeAgent",
    "normalizeSender",
    "getActiveSession",
    "getSession",
    "createSession",
    "navigateSession",
    "removeSession",
    "bindAgentToSession",
    "createAgentForSession",
    "markSessionOffline",
    "updateSessionNavigation",
    "updateHeartbeat",
    "pingAgent",
    "sendPrompt",
    "stopAgent"
  ]);
  const STATE_STORE_METHODS = Object.freeze(["get", "set"]);
  const TRANSACTIONAL_STATE_STORE_METHODS = Object.freeze(["get", "set", "remove", "clear", "transaction"]);
  const TIMER_RUNTIME_METHODS = Object.freeze(["scheduleRecurring", "cancel"]);

  const API_COMMANDS = Object.freeze([
    "startProject",
    "startExecution",
    "registerActiveLead",
    "createWorkers",
    "bindProtocolContext",
    "clearProtocolContext",
    "sendAgentPrompt",
    "stopAgent",
    "openExecutor",
    "schedulerTick",
    "retryTask",
    "cancelTask",
    "changePriority",
    "reassignAgent",
    "requestReview",
    "startIntegration",
    "pause",
    "stopNow",
    "resume",
    "exportProjectBundle",
    "importProjectBundle",
    "exportDebugBundle"
  ]);

  const API_QUERIES = Object.freeze([
    "state",
    "dashboard",
    "taskGraph",
    "taskDetails",
    "agents",
    "events",
    "warnings",
    "metrics",
    "reviewDetails",
    "integrationEvidence",
    "project",
    "scheduler",
    "schedulerDecisions",
    "recovery",
    "persistence"
  ]);

  function missingMethods(value, methods) {
    return methods.filter((method) => typeof value?.[method] !== "function");
  }

  function assertContract(name, value, methods) {
    const missing = missingMethods(value, methods);
    if (missing.length) throw new TypeError(`${name}_contract_missing:${missing.join(",")}`);
    return value;
  }

  function assertAgentRuntime(value) { return assertContract("agent_runtime", value, AGENT_RUNTIME_METHODS); }
  function assertStateStore(value) { return assertContract("state_store", value, STATE_STORE_METHODS); }
  function assertTransactionalStateStore(value) { return assertContract("transactional_state_store", value, TRANSACTIONAL_STATE_STORE_METHODS); }
  function assertTimerRuntime(value) { return assertContract("timer_runtime", value, TIMER_RUNTIME_METHODS); }

  function normalizeRuntimeSender(sender = {}) {
    const kind = String(sender.kind || "unknown");
    const sessionId = sender.sessionId === null || sender.sessionId === undefined ? null : String(sender.sessionId);
    const agentId = sender.agentId ? String(sender.agentId) : null;
    return {
      kind,
      sessionId,
      agentId,
      url: String(sender.url || ""),
      legacyTabId: Number.isInteger(sender.legacyTabId) ? sender.legacyTabId : null
    };
  }

  root.PlatformContracts = {
    CONTRACT_VERSION,
    AGENT_RUNTIME_METHODS,
    STATE_STORE_METHODS,
    TRANSACTIONAL_STATE_STORE_METHODS,
    TIMER_RUNTIME_METHODS,
    API_COMMANDS,
    API_QUERIES,
    assertAgentRuntime,
    assertStateStore,
    assertTransactionalStateStore,
    assertTimerRuntime,
    normalizeRuntimeSender
  };

  if (typeof module !== "undefined" && module.exports) module.exports = root.PlatformContracts;
})();
