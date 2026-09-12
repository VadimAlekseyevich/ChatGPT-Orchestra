"use strict";

importScripts(
  "../content/message-types.js",
  "../protocol/orchestra-protocol.js",
  "../prompts/planning-prompts.js",
  "../prompts/worker-prompts.js",
  "tab-registry.js",
  "event-store.js",
  "event-bus.js",
  "project-store.js",
  "dag-validator.js",
  "planning-engine.js",
  "conflict-policy.js",
  "git-provider.js",
  "scheduler-store.js",
  "scheduler-engine.js",
  "orchestrator.js"
);

const root = globalThis.ChatGPTOrchestra;
const registry = new root.TabRegistry();
const eventStore = new root.EventStore();
const eventBus = new root.EventBus({ registry, store: eventStore });
const projectStore = new root.ProjectStore();
const schedulerStore = new root.SchedulerStore();
const gitProvider = new root.GitProvider.GitHubRestProvider();

let orchestrator = null;
const planningEngine = new root.PlanningEngine({
  projectStore,
  registry,
  eventBus,
  sendPrompt: (agentId, prompt) => orchestrator.sendPromptToAgent(agentId, prompt)
});
const schedulerEngine = new root.SchedulerEngine({
  store: schedulerStore,
  projectStore,
  registry,
  eventBus,
  gitProvider,
  sendPrompt: (agentId, prompt) => orchestrator.sendPromptToAgent(agentId, prompt)
});
orchestrator = new root.ServiceWorkerOrchestrator({ registry, eventBus, planningEngine, schedulerEngine });
let readyPromise = orchestrator.init();

function withReady(callback) {
  return Promise.resolve(readyPromise)
    .catch((error) => {
      console.error("[ChatGPT Orchestra] service_worker_init_failed", error);
      readyPromise = orchestrator.init();
      return readyPromise;
    })
    .then(callback);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  withReady(() => orchestrator.handleRuntimeMessage(message, sender))
    .then((result) => sendResponse(result))
    .catch((error) => sendResponse({
      ok: false,
      reason: "service_worker_exception",
      message: error?.message || String(error)
    }));
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  withReady(() => orchestrator.handleTabRemoved(tabId)).catch((error) => {
    console.warn("[ChatGPT Orchestra] tab_removed_handler_failed", error);
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  withReady(() => orchestrator.handleTabUpdated(tabId, changeInfo, tab)).catch((error) => {
    console.warn("[ChatGPT Orchestra] tab_updated_handler_failed", error);
  });
});

const SCHEDULER_WATCHDOG_ALARM = "orchestra-scheduler-watchdog";
if (chrome.alarms?.create) chrome.alarms.create(SCHEDULER_WATCHDOG_ALARM, { periodInMinutes: 1 });
if (chrome.alarms?.onAlarm) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm?.name !== SCHEDULER_WATCHDOG_ALARM) return;
    withReady(() => schedulerEngine.tick({ reason: "watchdog_alarm" })).catch((error) => {
      console.warn("[ChatGPT Orchestra] scheduler_watchdog_failed", error);
    });
  });
}
