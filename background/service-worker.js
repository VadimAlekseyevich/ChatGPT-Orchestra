"use strict";

importScripts(
  "../content/message-types.js",
  "../protocol/orchestra-protocol.js",
  "../prompts/planning-prompts.js",
  "../prompts/worker-prompts.js",
  "../prompts/review-prompts.js",
  "../prompts/integration-prompts.js",
  "../platform/contracts.js",
  "../platform/extension-runtime.js",
  "../platform/transactional-state-store.js",
  "../persistence/migration-registry.js",
  "../persistence/portable-state.js",
  "../persistence/project-bundle.js",
  "tab-registry.js",
  "event-store.js",
  "event-bus.js",
  "project-store.js",
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
const migrationRegistry = new root.MigrationRegistry({ currentVersion: root.PortableState.PORTABLE_SCHEMA_VERSION });
const portableStateManager = new root.PortableState.PortableStateManager({ stateStore, migrations: migrationRegistry });
const projectBundleService = new root.ProjectBundle.ProjectBundleService({ portableStateManager, sourceHost: "edge-extension" });
const gitProvider = new root.GitProvider.GitHubRestProvider();
const timerRuntime = new root.ChromeAlarmRuntime({ chromeApi: chrome });
root.PlatformContracts.assertTimerRuntime(timerRuntime);
const persistenceInfo = () => ({ backend: "chrome.storage.local", transactionalWrapper: true });

let schedulerEngine = null;
const planningEngine = new root.PlanningEngine({
  projectStore,
  registry: agentRuntime,
  eventBus,
  sendPrompt: (agentId, prompt) => agentRuntime.sendPrompt(agentId, prompt)
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
  taskControlService
});

function initializeRuntime() {
  return recoveryController.prepareForBoot()
    .then(() => orchestrator.init())
    .then(() => integrationEngine.init())
    .then(() => recoveryController.afterRuntimeInit());
}

let readyPromise = initializeRuntime();
let portableReloadPending = false;

function withReady(callback) {
  return Promise.resolve(readyPromise)
    .catch((error) => {
      console.error("[ChatGPT Orchestra] service_worker_init_failed", error);
      readyPromise = initializeRuntime();
      return readyPromise;
    })
    .then(callback);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  withReady(async () => {
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
      reason: "service_worker_exception",
      message: error?.message || String(error)
    }));
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (portableReloadPending) return;
  withReady(async () => {
    const sessionId = String(tabId);
    const agent = agentRuntime.getAgentBySessionId(sessionId);
    await orchestrator.handleSessionRemoved(sessionId);
    if (agent) await integrationEngine.handleAgentUnavailable(agent.agentId, "session_closed");
    await recoveryController.tick({ reason: "session_removed" });
  }).catch((error) => {
    console.warn("[ChatGPT Orchestra] session_removed_handler_failed", error);
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (portableReloadPending) return;
  withReady(async () => {
    const sessionId = String(tabId);
    const session = { id: sessionId, url: tab?.url || changeInfo?.url || "", active: Boolean(tab?.active) };
    await orchestrator.handleSessionUpdated(sessionId, changeInfo, session);
    const agent = agentRuntime.getAgentBySessionId(sessionId);
    if (agent) await integrationEngine.handleAgentStateChanged(agent);
    await recoveryController.tick({ reason: "session_updated" });
  }).catch((error) => {
    console.warn("[ChatGPT Orchestra] session_updated_handler_failed", error);
  });
});

const SCHEDULER_WATCHDOG_ALARM = "orchestra-scheduler-watchdog";
timerRuntime.scheduleRecurring(SCHEDULER_WATCHDOG_ALARM, { periodMinutes: 1 }, () => {
  if (portableReloadPending) return;
  return withReady(async () => {
    await schedulerEngine.tick({ reason: "watchdog_alarm" });
    await integrationEngine.tick({ reason: "watchdog_alarm" });
    await recoveryController.tick({ reason: "watchdog_alarm" });
  }).catch((error) => {
    console.warn("[ChatGPT Orchestra] watchdog_failed", error);
  });
});
