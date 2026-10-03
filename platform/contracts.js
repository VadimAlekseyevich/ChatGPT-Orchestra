(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};
  const CONTRACT_VERSION = 7;

  // Portable Core contract. No browser/session/process handles are part of this surface.
  const AGENT_RUNTIME_METHODS = Object.freeze([
    "load","snapshot","listAgents","getAgent","getAgentLifecycle","isAgentConnected","isAgentReady","isAgentBusy","isAgentAvailable","subscribeAgentEvents","setRuntimeStatus","setProtocolContext","clearProtocolContext","removeAgent","pingAgent","sendPrompt","stopAgent"
  ]);

  // Host adapter contract. Browser-backed runtimes may implement this, but Orchestra Core must not depend on it.
  const RUNTIME_CONTROL_METHODS = Object.freeze([
    "getAgentBySessionId","getActiveSession","getSession","createSession","navigateSession","removeSession","bindAgentToSession","createAgentForSession","markSessionOffline","updateSessionNavigation","updateHeartbeat","normalizeSender"
  ]);

  const STATE_STORE_METHODS = Object.freeze(["get", "set"]);
  const TRANSACTIONAL_STATE_STORE_METHODS = Object.freeze(["get", "set", "remove", "clear", "transaction"]);
  const TIMER_RUNTIME_METHODS = Object.freeze(["scheduleRecurring", "cancel"]);
  const COMPANION_TRANSPORT_METHODS = Object.freeze(["connect", "disconnect", "getStatus", "send", "subscribe"]);
  const GIT_WORKSPACE_METHODS = Object.freeze(["loadRepository","snapshotBase","createTaskWorkspace","createIntegrationWorkspace","status","diff","validateScope","runVerification","commit","cleanup"]);

  const API_COMMANDS = Object.freeze([
    "startProject","startExecution","registerActiveLead","createWorkers","bindProtocolContext","clearProtocolContext","sendAgentPrompt","stopAgent","openExecutor","schedulerTick","retryTask","cancelTask","changePriority","reassignAgent","requestReview","startIntegration","pause","stopNow","resume","exportProjectBundle","importProjectBundle","exportDebugBundle",
    "openLocalRepository","cloneRepository","setRepositoryTrust","createTaskWorkspace","createIntegrationWorkspace","materializeTaskArtifact","verifyWorkspace","cancelVerification","commitWorkspace","mergeTaskArtifact","pushWorkspace","cleanupWorkspace","cleanupAbandonedWorkspaces"
  ]);

  const API_QUERIES = Object.freeze([
    "state","dashboard","taskGraph","taskDetails","agents","events","warnings","metrics","reviewDetails","integrationEvidence","contextSummary","contextPacket","project","scheduler","schedulerDecisions","recovery","persistence",
    "repositories","repository","workspaceStatus","workspaceDiff","workspaceArtifact","workspaceScope","workspaceRecovery","verificationRuns"
  ]);

  function missingMethods(value, methods) { return methods.filter((method) => typeof value?.[method] !== "function"); }
  function assertContract(name, value, methods) {
    const missing = missingMethods(value, methods);
    if (missing.length) throw new TypeError(`${name}_contract_missing:${missing.join(",")}`);
    return value;
  }
  function assertAgentRuntime(value) { return assertContract("agent_runtime", value, AGENT_RUNTIME_METHODS); }
  function assertRuntimeControl(value) { return assertContract("runtime_control", value, RUNTIME_CONTROL_METHODS); }
  function assertStateStore(value) { return assertContract("state_store", value, STATE_STORE_METHODS); }
  function assertTransactionalStateStore(value) { return assertContract("transactional_state_store", value, TRANSACTIONAL_STATE_STORE_METHODS); }
  function assertTimerRuntime(value) { return assertContract("timer_runtime", value, TIMER_RUNTIME_METHODS); }
  function assertCompanionTransport(value) { return assertContract("companion_transport", value, COMPANION_TRANSPORT_METHODS); }
  function assertGitWorkspace(value) { return assertContract("git_workspace", value, GIT_WORKSPACE_METHODS); }

  function normalizePortableSender(sender = {}) {
    const runtimeKind = String(sender.runtimeKind || sender.kind || "unknown");
    const agentId = sender.agentId ? String(sender.agentId) : null;
    const bindingPresent = sender.bindingPresent === null || sender.bindingPresent === undefined
      ? null
      : Boolean(sender.bindingPresent);
    return { runtimeKind, agentId, bindingPresent };
  }

  root.PlatformContracts = {
    CONTRACT_VERSION,
    AGENT_RUNTIME_METHODS,
    RUNTIME_CONTROL_METHODS,
    STATE_STORE_METHODS,
    TRANSACTIONAL_STATE_STORE_METHODS,
    TIMER_RUNTIME_METHODS,
    COMPANION_TRANSPORT_METHODS,
    GIT_WORKSPACE_METHODS,
    API_COMMANDS,
    API_QUERIES,
    assertAgentRuntime,
    assertRuntimeControl,
    assertStateStore,
    assertTransactionalStateStore,
    assertTimerRuntime,
    assertCompanionTransport,
    assertGitWorkspace,
    normalizePortableSender
  };

  if (typeof module !== "undefined" && module.exports) module.exports = root.PlatformContracts;
})();
