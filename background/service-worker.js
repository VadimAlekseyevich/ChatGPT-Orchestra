"use strict";

importScripts(
  "../content/message-types.js",
  "../protocol/orchestra-protocol.js",
  "../prompts/planning-prompts.js",
  "../prompts/worker-prompts.js",
  "../prompts/review-prompts.js",
  "../prompts/integration-prompts.js",
  "../context/context-packets.js",
  "../platform/contracts.js",
  "../platform/extension-runtime.js",
  "../platform/companion-protocol.js",
  "../platform/companion-rpc.js",
  "../platform/native-messaging-transport.js",
  "../platform/extension-companion-endpoint.js",
  "../platform/extension-companion-mode.js",
  "../platform/transactional-state-store.js",
  "../persistence/migration-registry.js",
  "../persistence/portable-state.js",
  "../persistence/project-bundle.js",
  "tab-registry.js",
  "event-store.js",
  "event-bus.js",
  "project-store.js",
  "context-store.js",
  "dag-validator.js",
  "planning-engine.js",
  "conflict-policy.js",
  "git-provider.js",
  "scheduler-store.js",
  "review-store.js",
  "review-engine.js",
  "integration-policy.js",
  "integration-store.js",
  "integration-engine.js",
  "integration-recovery.js",
  "scheduler-engine.js",
  "orchestrator.js",
  "recovery-store.js",
  "recovery-controller.js",
  "recovery-hooks.js",
  "recovery-stop-guards.js",
  "observability-service.js",
  "task-control-service.js",
  "orchestrator-api.js"
);

const root = globalThis.ChatGPTOrchestra;
const chromeStateStore = new root.ChromeStorageStateStore({ storageArea: chrome.storage.local });
const stateStore = new root.TransactionalStateStore({ store: chromeStateStore });
root.PlatformContracts.assertTransactionalStateStore(stateStore);

const registry = new root.TabRegistry({ stateStore });
const agentRuntime = new root.ExtensionAgentRuntime({
  chromeApi: chrome,
  registry,
  messageTypes: root.MESSAGE_TYPES
});
agentRuntime.activateAgent = async (agentId) => {
  const sessionId = agentRuntime.sessionIdForAgent(agentId);
  const tabId = Number(sessionId);
  if (!Number.isInteger(tabId)) return { ok: false, reason: "agent_offline", agentId };
  try {
    const tab = await chrome.tabs.update(tabId, { active: true });
    return { ok: true, agentId, session: tab ? { id: String(tab.id), url: String(tab.url || ""), active: Boolean(tab.active) } : { id: sessionId, active: true } };
  } catch (error) {
    return { ok: false, reason: "agent_activation_failed", agentId, message: error?.message || String(error) };
  }
};
root.PlatformContracts.assertAgentRuntime(agentRuntime);

const eventStore = new root.EventStore({ stateStore });
const eventBus = new root.EventBus({ registry: agentRuntime, store: eventStore });
const projectStore = new root.ProjectStore({ storageArea: stateStore });
const schedulerStore = new root.SchedulerStore({ storageArea: stateStore });
const reviewStore = new root.ReviewStore({ storageArea: stateStore });
const integrationStore = new root.IntegrationStore({ storageArea: stateStore });
const recoveryStore = new root.RecoveryStore({ storageArea: stateStore });
const contextStore = new root.ContextStore({ storageArea: stateStore });
const migrationRegistry = new root.MigrationRegistry({ currentVersion: root.PortableState.PORTABLE_SCHEMA_VERSION });
const portableStateManager = new root.PortableState.PortableStateManager({ stateStore, migrations: migrationRegistry });
const projectBundleService = new root.ProjectBundle.ProjectBundleService({ portableStateManager, sourceHost: "edge-extension" });
const gitProvider = new root.GitProvider.GitHubRestProvider();
const timerRuntime = new root.ChromeAlarmRuntime({ chromeApi: chrome });
root.PlatformContracts.assertTimerRuntime(timerRuntime);
const persistenceInfo = () => ({ backend: "chrome.storage.local", transactionalWrapper: true });

const companionController = new root.ExtensionCompanionModeController({
  chromeApi: chrome,
  storageArea: chrome.storage.local,
  agentRuntime,
  timerRuntime,
  logger: console
});

const contextPackets = new root.ContextPackets.ContextPacketService({
  contextStore,
  projectStore,
  schedulerStore,
  reviewStore,
  integrationStore,
  recoveryStore
});
root.ContextPackets.setDefaultService(contextPackets);

let schedulerEngine = null;
const planningEngine = new root.PlanningEngine({
  projectStore,
  registry: agentRuntime,
  eventBus,
  sendPrompt: (agentId, prompt, sendOptions) => agentRuntime.sendPrompt(agentId, prompt, sendOptions)
});
const reviewEngine = new root.ReviewEngine({
  store: reviewStore,
  schedulerStore,
  projectStore,
  registry: agentRuntime,
  eventBus,
  gitProvider,
  sendPrompt: (agentId, prompt) => agentRuntime.sendPrompt(agentId, prompt),
  onSchedulerTick: (options) => schedulerEngine?.tick(options)
});
const integrationEngine = new root.RecoverableIntegrationEngine({
  store: integrationStore,
  schedulerStore,
  projectStore,
  registry: agentRuntime,
  eventBus,
  gitProvider,
  sendPrompt: (agentId, prompt) => agentRuntime.sendPrompt(agentId, prompt)
});
schedulerEngine = new root.SchedulerEngine({
  store: schedulerStore,
  projectStore,
  registry: agentRuntime,
  eventBus,
  gitProvider,
  reviewEngine,
  sendPrompt: (agentId, prompt) => agentRuntime.sendPrompt(agentId, prompt)
});
const orchestrator = new root.ServiceWorkerOrchestrator({
  agentRuntime,
  eventBus,
  planningEngine,
  schedulerEngine
});

const recoveryController = new root.RecoveryController({
  store: recoveryStore,
  projectStore,
  schedulerStore,
  reviewStore,
  integrationStore,
  registry: agentRuntime,
  planningEngine,
  schedulerEngine,
  reviewEngine,
  integrationEngine,
  gitProvider
});
root.RecoveryRuntime.controller = recoveryController;
recoveryController.setActions({
  stopAgent: (agentId) => agentRuntime.stopAgent(agentId),
  createWorkers: (count) => orchestrator.createWorkers(count),
  reconcileTabs: () => orchestrator.reconcileRegisteredSessions()
});

const observabilityService = new root.ObservabilityService({
  projectStore,
  schedulerStore,
  reviewStore,
  integrationStore,
  registry: agentRuntime,
  eventBus,
  recoveryController,
  persistenceInfo
});
const taskControlService = new root.TaskControlService({
  schedulerStore,
  schedulerEngine,
  reviewStore,
  reviewEngine,
  integrationEngine,
  registry: agentRuntime,
  recoveryController
});

const orchestratorApi = new root.OrchestratorApi({
  orchestrator,
  planningEngine,
  schedulerEngine,
  reviewEngine,
  integrationEngine,
  recoveryController,
  eventBus,
  projectBundleService,
  persistenceInfo,
  observabilityService,
  taskControlService,
  contextStore,
  contextPackets
});

const SCHEDULER_WATCHDOG_ALARM = "orchestra-scheduler-watchdog";
const MIGRATION_SAFE_RECOVERY_STATES = new Set(["IDLE", "PAUSED", "STOPPED", "RECOVERY_REQUIRED"]);
let localRuntimeInitialized = false;
let localRuntimeActive = false;
let watchdogCancel = null;
let portableReloadPending = false;

async function startWatchdog() {
  if (watchdogCancel) return;
  watchdogCancel = timerRuntime.scheduleRecurring(SCHEDULER_WATCHDOG_ALARM, { periodMinutes: 1 }, () => {
    if (!localRuntimeActive || portableReloadPending || companionController.isEnabled()) return;
    return Promise.resolve()
      .then(() => schedulerEngine.tick({ reason: "watchdog_alarm" }))
      .then(() => integrationEngine.tick({ reason: "watchdog_alarm" }))
      .then(() => recoveryController.tick({ reason: "watchdog_alarm" }))
      .catch((error) => console.warn("[ChatGPT Orchestra] watchdog_failed", error));
  });
}

async function suspendLocalRuntime() {
  localRuntimeActive = false;
  const cancel = watchdogCancel;
  watchdogCancel = null;
  if (cancel) await cancel();
}

async function initializeLocalRuntime() {
  if (!localRuntimeInitialized) {
    await contextPackets.init();
    await recoveryController.prepareForBoot();
    await orchestrator.init();
    await integrationEngine.init();
    await recoveryController.afterRuntimeInit();
    localRuntimeInitialized = true;
  }
  localRuntimeActive = true;
  await startWatchdog();
  return { mode: "extension", active: true };
}

async function initializeRuntime() {
  const companion = await companionController.load();
  if (companion.enabled) {
    await suspendLocalRuntime();
    return { mode: "companion", companion };
  }
  return initializeLocalRuntime();
}

let readyPromise = initializeRuntime();

function withReady(callback) {
  return Promise.resolve(readyPromise)
    .catch((error) => {
      console.error("[ChatGPT Orchestra] service_worker_init_failed", error);
      readyPromise = initializeRuntime();
      return readyPromise;
    })
    .then(callback);
}

async function stageActiveProjectMigration() {
  if (companionController.isEnabled()) return { ok: false, reason: "companion_migration_requires_extension_mode" };
  if (!localRuntimeActive) await initializeLocalRuntime();
  const projectId = projectStore.getActiveProject()?.projectId || null;
  if (!projectId) return { ok: false, reason: "companion_migration_project_missing" };

  const recovery = recoveryStore.summary?.() || {};
  const recoveryStatus = String(recovery.status || "IDLE");
  if (!MIGRATION_SAFE_RECOVERY_STATES.has(recoveryStatus)) {
    return { ok: false, reason: "companion_migration_requires_safe_point", recoveryStatus };
  }

  const exported = await projectBundleService.exportBundle({ projectId });
  if (!exported?.ok) return exported || { ok: false, reason: "project_bundle_export_failed" };
  const staged = await companionController.stageMigrationBundle(exported.serialized);
  return staged?.ok
    ? { ...staged, bundleBytes: exported.bytes || 0, filename: exported.filename || null }
    : staged;
}

async function handleCompanionControl(message) {
  const TYPES = root.MESSAGE_TYPES;
  if (message?.type === TYPES.COMPANION_GET_STATUS) {
    if (companionController.isEnabled()) await companionController.ensureConnected({ throwOnFailure: false });
    return { ok: true, companion: companionController.getStatus(), localRuntimeActive };
  }
  if (message?.type === TYPES.COMPANION_GET_MIGRATION_STATUS) {
    try {
      const migration = await companionController.getMigrationStatus();
      return { ok: true, migration };
    } catch (error) {
      return { ok: false, reason: "companion_migration_status_unavailable", message: error?.message || String(error) };
    }
  }
  if (message?.type === TYPES.COMPANION_MIGRATE_PROJECT) return stageActiveProjectMigration();
  if (message?.type === TYPES.COMPANION_ENABLE) {
    const companion = await companionController.setEnabled(true);
    if (!companion.enabled) {
      return { ok: false, reason: companion.reason || "companion_enable_rejected", companion, localRuntimeActive };
    }
    await suspendLocalRuntime();
    return { ok: true, companion, localRuntimeActive: false };
  }
  if (message?.type === TYPES.COMPANION_DISABLE) {
    const companion = await companionController.setEnabled(false);
    await initializeLocalRuntime();
    return { ok: true, companion, localRuntimeActive: true };
  }
  if (message?.type === TYPES.COMPANION_RECONNECT) {
    const companion = await companionController.reconnect();
    return { ok: true, companion, localRuntimeActive };
  }
  return null;
}

async function companionUnavailable() {
  const status = await companionController.ensureConnected({ throwOnFailure: false });
  if (status.connected) return null;
  return { ok: false, reason: "companion_disconnected", companion: status };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  withReady(async () => {
    const control = await handleCompanionControl(message);
    if (control) return control;

    if (companionController.isEnabled()) {
      const unavailable = await companionUnavailable();
      if (unavailable) return unavailable;
      const senderContext = agentRuntime.normalizeSender(sender);
      return senderContext.sessionId
        ? companionController.forwardRuntimeMessage(message, sender)
        : companionController.forwardApiMessage(message, sender);
    }

    if (!localRuntimeActive) await initializeLocalRuntime();
    if (portableReloadPending) return { ok: false, reason: "portable_reload_pending" };
    const senderContext = agentRuntime.normalizeSender(sender);
    const genericCommand = message?.type === root.MESSAGE_TYPES.ORCHESTRATOR_API_EXECUTE ? String(message?.payload?.name || "") : "";
    const isPortableImport = !senderContext.sessionId && (
      message?.type === root.MESSAGE_TYPES.ORCHESTRATOR_IMPORT_PROJECT
      || (message?.type === root.MESSAGE_TYPES.ORCHESTRATOR_API_EXECUTE && genericCommand === "importProjectBundle")
    );
    if (isPortableImport) portableReloadPending = true;

    let result;
    try {
      result = senderContext.sessionId
        ? await orchestrator.handleRuntimeMessage(message, senderContext)
        : await orchestratorApi.handleLegacyMessage(message, senderContext);
    } catch (error) {
      if (isPortableImport) portableReloadPending = false;
      throw error;
    }
    if (isPortableImport && !result?.ok) portableReloadPending = false;

    const projectStarted = message?.type === root.MESSAGE_TYPES.ORCHESTRATOR_START_PROJECT || genericCommand === "startProject";
    const executionStarted = message?.type === root.MESSAGE_TYPES.ORCHESTRATOR_START_EXECUTION || genericCommand === "startExecution";
    if (projectStarted && result?.ok) {
      const projectId = projectStore.getActiveProject()?.projectId;
      if (projectId) await recoveryController.attachProject(projectId, "project_started");
    }
    if (executionStarted && result?.ok) {
      const projectId = projectStore.getActiveProject()?.projectId;
      if (projectId && recoveryStore.summary().projectId !== projectId) await recoveryController.attachProject(projectId, "execution_started");
    }

    if (isPortableImport && result?.ok && result?.reloadRequired) return result;

    if (senderContext.agentId) {
      const agent = agentRuntime.getAgent(senderContext.agentId);
      if (agent) await integrationEngine.handleAgentStateChanged(agent);
    }
    await recoveryController.tick({ reason: genericCommand || message?.type || "runtime_message" });
    return result;
  })
    .then((result) => sendResponse(result))
    .catch((error) => sendResponse({
      ok: false,
      reason: companionController.isEnabled() ? "companion_bridge_exception" : "service_worker_exception",
      message: error?.message || String(error),
      companion: companionController.isEnabled() ? companionController.getStatus() : undefined
    }));
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (portableReloadPending && !companionController.isEnabled()) return;
  withReady(async () => {
    const sessionId = String(tabId);
    if (companionController.isEnabled()) {
      const unavailable = await companionUnavailable();
      if (!unavailable) await companionController.forwardSessionRemoved(sessionId);
      return;
    }
    if (!localRuntimeActive) await initializeLocalRuntime();
    const agent = agentRuntime.getAgentBySessionId(sessionId);
    await orchestrator.handleSessionRemoved(sessionId);
    if (agent) await integrationEngine.handleAgentUnavailable(agent.agentId, "session_closed");
    await recoveryController.tick({ reason: "session_removed" });
  }).catch((error) => {
    console.warn("[ChatGPT Orchestra] session_removed_handler_failed", error);
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (portableReloadPending && !companionController.isEnabled()) return;
  withReady(async () => {
    const sessionId = String(tabId);
    const session = { id: sessionId, url: tab?.url || changeInfo?.url || "", active: Boolean(tab?.active) };
    if (companionController.isEnabled()) {
      const unavailable = await companionUnavailable();
      if (!unavailable) await companionController.forwardSessionUpdated(sessionId, changeInfo, session);
      return;
    }
    if (!localRuntimeActive) await initializeLocalRuntime();
    await orchestrator.handleSessionUpdated(sessionId, changeInfo, session);
    const agent = agentRuntime.getAgentBySessionId(sessionId);
    if (agent) await integrationEngine.handleAgentStateChanged(agent);
    await recoveryController.tick({ reason: "session_updated" });
  }).catch((error) => {
    console.warn("[ChatGPT Orchestra] session_updated_handler_failed", error);
  });
});
