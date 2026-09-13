"use strict";

importScripts(
  "../content/message-types.js",
  "../protocol/orchestra-protocol.js",
  "../prompts/planning-prompts.js",
  "../prompts/worker-prompts.js",
  "../prompts/review-prompts.js",
  "../prompts/integration-prompts.js",
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
  "recovery-hooks.js"
);

const root = globalThis.ChatGPTOrchestra;
const registry = new root.TabRegistry();
const eventStore = new root.EventStore();
const eventBus = new root.EventBus({ registry, store: eventStore });
const projectStore = new root.ProjectStore();
const schedulerStore = new root.SchedulerStore();
const reviewStore = new root.ReviewStore();
const integrationStore = new root.IntegrationStore();
const recoveryStore = new root.RecoveryStore();
const gitProvider = new root.GitProvider.GitHubRestProvider();

let orchestrator = null;
let schedulerEngine = null;
const planningEngine = new root.PlanningEngine({
  projectStore,
  registry,
  eventBus,
  sendPrompt: (agentId, prompt) => orchestrator.sendPromptToAgent(agentId, prompt)
});
const reviewEngine = new root.ReviewEngine({
  store: reviewStore,
  schedulerStore,
  projectStore,
  registry,
  eventBus,
  gitProvider,
  sendPrompt: (agentId, prompt) => orchestrator.sendPromptToAgent(agentId, prompt),
  onSchedulerTick: (options) => schedulerEngine?.tick(options)
});
const integrationEngine = new root.RecoverableIntegrationEngine({
  store: integrationStore,
  schedulerStore,
  projectStore,
  registry,
  eventBus,
  gitProvider,
  sendPrompt: (agentId, prompt) => orchestrator.sendPromptToAgent(agentId, prompt)
});
schedulerEngine = new root.SchedulerEngine({
  store: schedulerStore,
  projectStore,
  registry,
  eventBus,
  gitProvider,
  reviewEngine,
  sendPrompt: (agentId, prompt) => orchestrator.sendPromptToAgent(agentId, prompt)
});
orchestrator = new root.ServiceWorkerOrchestrator({ registry, eventBus, planningEngine, schedulerEngine });

const recoveryController = new root.RecoveryController({
  store: recoveryStore,
  projectStore,
  schedulerStore,
  reviewStore,
  integrationStore,
  registry,
  planningEngine,
  schedulerEngine,
  reviewEngine,
  integrationEngine,
  gitProvider
});
root.RecoveryRuntime.controller = recoveryController;
recoveryController.setActions({
  stopAgent: (agentId) => orchestrator.stopAgent(agentId),
  createWorkers: (count) => orchestrator.createWorkers(count),
  reconcileTabs: () => orchestrator.reconcileRegisteredTabs()
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
    const recoveryCommand = await recoveryController.handleRuntimeMessage(message, sender);
    if (recoveryCommand.handled) return recoveryCommand.response;

    const result = await orchestrator.handleRuntimeMessage(message, sender);
    if (message?.type === root.MESSAGE_TYPES.ORCHESTRATOR_START_PROJECT && result?.ok) {
      const projectId = projectStore.getActiveProject()?.projectId;
      if (projectId) await recoveryController.attachProject(projectId, "project_started");
    }
    if (message?.type === root.MESSAGE_TYPES.ORCHESTRATOR_START_EXECUTION && result?.ok) {
      const projectId = projectStore.getActiveProject()?.projectId;
      if (projectId && recoveryStore.summary().projectId !== projectId) await recoveryController.attachProject(projectId, "execution_started");
    }

    const tabId = sender?.tab?.id;
    if (Number.isInteger(tabId)) {
      const agent = registry.getAgentByTabId(tabId);
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
    const agent = registry.getAgentByTabId(tabId);
    await orchestrator.handleTabRemoved(tabId);
    if (agent) await integrationEngine.handleAgentUnavailable(agent.agentId, "tab_closed");
    await recoveryController.tick({ reason: "tab_removed" });
  }).catch((error) => {
    console.warn("[ChatGPT Orchestra] tab_removed_handler_failed", error);
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  withReady(async () => {
    await orchestrator.handleTabUpdated(tabId, changeInfo, tab);
    const agent = registry.getAgentByTabId(tabId);
    if (agent) await integrationEngine.handleAgentStateChanged(agent);
    await recoveryController.tick({ reason: "tab_updated" });
  }).catch((error) => {
    console.warn("[ChatGPT Orchestra] tab_updated_handler_failed", error);
  });
});

const SCHEDULER_WATCHDOG_ALARM = "orchestra-scheduler-watchdog";
if (chrome.alarms?.create) chrome.alarms.create(SCHEDULER_WATCHDOG_ALARM, { periodInMinutes: 1 });
if (chrome.alarms?.onAlarm) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm?.name !== SCHEDULER_WATCHDOG_ALARM) return;
    withReady(async () => {
      await schedulerEngine.tick({ reason: "watchdog_alarm" });
      await integrationEngine.tick({ reason: "watchdog_alarm" });
      await recoveryController.tick({ reason: "watchdog_alarm" });
    }).catch((error) => {
      console.warn("[ChatGPT Orchestra] watchdog_failed", error);
    });
  });
}
