"use strict";

importScripts(
  "../content/message-types.js",
  "tab-registry.js",
  "orchestrator.js"
);

const root = globalThis.ChatGPTOrchestra;
const registry = new root.TabRegistry();
const orchestrator = new root.ServiceWorkerOrchestrator({ registry });
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

chrome.runtime.onStartup.addListener(() => {
  readyPromise = orchestrator.init();
});

chrome.runtime.onInstalled.addListener(() => {
  readyPromise = orchestrator.init();
});
