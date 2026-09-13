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
  "orchestrator-api.js"
);

const root = globalThis.ChatGPTOrchestra;
const stateStore = new root.ChromeStorageStateStore({ storageArea: chrome.storage.local });
root.PlatformContracts.assertStateStore(stateStore);

const registry = new root.TabRegistry({ stateStore });
const agentRuntime = new root.ExtensionAgentRuntime({
  chromeApi: chrome,
  registry,
  messageTypes: root.MESSAGE_TYPES
});
root.PlatformContracts.assertAgentRuntime(agentRuntime);

const eventStore = new root.EventStore({ stateStore });
const eventBus = new root.EventBus({ registry: agentRuntime, store: eventStore });
const projectStore = new root.ProjectStore({ storageArea: stateStore });
const schedulerStore = new root.SchedulerStore({ storageArea: stateStore });
const reviewStore = new root.ReviewStore({ storageArea: stateStore });
const integrationStore = new root.IntegrationStore({ storageArea: stateStore });
const recoveryStore = new root.RecoveryStore({ storageArea: stateStore });
const gitProvider = new root.GitProvider.GitHubRestProvider();
const timerRuntime = new root.ChromeAlarmRuntime({ chromeApi: chrome });
root.PlatformContracts.assertTimerRuntime(timerRuntime);

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

const orchestratorApi = new root.OrchestratorApi({
  orchestrator,
  planningEngine,
  schedulerEngine,
  reviewEngine,
  integrationEngine,
  recoveryController,
  eventBus
});

function initializeRuntime() {
  return recoveryController.prepareForBoot()
    .then(() => orchestrator.init())
    .then(() => integrationEngine.init())
    .then(() => recoveryController.afterRuntimeInit());
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  withReady(async () => {
    const senderContext = agentRuntime.normalizeSender(sender);
    const result = senderContext.sessionId
      ? await orchestrator.handleRuntimeMessage(message, senderContext)
      : await orchestratorApi.handleLegacyMessage(message, senderContext);

    if (message?.type === root.MESSAGE_TYPES.ORCHESTRATOR_START_PROJECT && result?.ok) {
      const projectId = projectStore.getActiveProject()?.projectId;
      if (projectId) await recoveryController.attachProject(projectId, "project_started");
    }
    if (message?.type === root.MESSAGE_TYPES.ORCHESTRATOR_START_EXECUTION && result?.ok) {
      const projectId = projectStore.getActiveProject()?.projectId;
      if (projectId && recoveryStore.summary().projectId !== projectId) await recoveryController.attachProject(projectId, "execution_started");
    }

    if (senderContext.agentId) {
      const agent = agentRuntime.getAgent(senderContext.agentId);
      if (agent) await integrationEngine.handleAgentStateChanged(agent);
    }
    await recoveryController.tick({ reason: message?.type || "runtime_message" });
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
timerRuntime.scheduleRecurring(SCHEDULER_WATCHDOG_ALARM, { periodMinutes: 1 }, () => withReady(async () => {
  await schedulerEngine.tick({ reason: "watchdog_alarm" });
  await integrationEngine.tick({ reason: "watchdog_alarm" });
  await recoveryController.tick({ reason: "watchdog_alarm" });
}).catch((error) => {
  console.warn("[ChatGPT Orchestra] watchdog_failed", error);
}));
