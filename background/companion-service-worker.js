"use strict";

importScripts(
  "../content/message-types.js",
  "../platform/contracts.js",
  "../platform/companion-protocol.js",
  "../platform/companion-rpc.js",
  "../platform/native-messaging-transport.js",
  "../platform/extension-runtime.js",
  "../platform/transactional-state-store.js",
  "tab-registry.js",
  "../platform/extension-companion-endpoint.js",
  "companion-mode-controller.js"
);

const root = globalThis.ChatGPTOrchestra;
const browserStore = new root.TransactionalStateStore({
  store: new root.ChromeStorageStateStore({ storageArea: chrome.storage.local })
});
const registry = new root.TabRegistry({ stateStore: browserStore });
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
    return {
      ok: true,
      agentId,
      session: tab
        ? { id: String(tab.id), url: String(tab.url || ""), active: Boolean(tab.active) }
        : { id: sessionId, active: true }
    };
  } catch (error) {
    return { ok: false, reason: "agent_activation_failed", agentId, message: error?.message || String(error) };
  }
};

const transport = new root.NativeMessagingTransport({ chromeApi: chrome });
const rpc = new root.CompanionRpcPeer({ transport, requestTimeoutMs: 15000 });
const endpoint = new root.ExtensionCompanionEndpoint({ rpc, agentRuntime });
const timerRuntime = new root.ChromeAlarmRuntime({ chromeApi: chrome });
const controller = new root.ExtensionCompanionController({ endpoint, timerRuntime });

controller.start().catch((error) => {
  console.warn("[ChatGPT Orchestra] companion_start_failed", error);
});

async function withCompanion(reason, callback) {
  const connected = await controller.ensureConnected(reason);
  if (!connected.ok) {
    return {
      ok: false,
      reason: "companion_disconnected",
      message: connected.message || null,
      companion: controller.getStatus()
    };
  }
  return callback();
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "ORCHESTRA_COMPANION_STATUS") {
    sendResponse({ ok: true, companion: controller.getStatus() });
    return false;
  }

  withCompanion("runtime_message", async () => {
    const senderContext = agentRuntime.normalizeSender(sender);
    return senderContext.sessionId
      ? endpoint.forwardRuntimeMessage(message, sender)
      : endpoint.forwardLegacyMessage(message, sender);
  })
    .then((result) => sendResponse(result))
    .catch((error) => sendResponse({
      ok: false,
      reason: "companion_proxy_exception",
      message: error?.message || String(error),
      companion: controller.getStatus()
    }));
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  withCompanion("session_removed", () => endpoint.forwardSessionRemoved(String(tabId)))
    .catch((error) => console.warn("[ChatGPT Orchestra] companion_session_removed_failed", error));
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const session = {
    id: String(tabId),
    url: tab?.url || changeInfo?.url || "",
    active: Boolean(tab?.active)
  };
  withCompanion("session_updated", () => endpoint.forwardSessionUpdated(String(tabId), changeInfo, session))
    .catch((error) => console.warn("[ChatGPT Orchestra] companion_session_updated_failed", error));
});
