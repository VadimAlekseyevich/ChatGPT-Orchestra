"use strict";

function isAdapterOwnedMessage(host, message) {
  const TYPES = host.root.MESSAGE_TYPES || {};
  return new Set([
    TYPES.CONTENT_READY,
    TYPES.CONTENT_HEARTBEAT,
    TYPES.CHAT_STATE,
    TYPES.ASSISTANT_RESPONSE_COMPLETED
  ].filter(Boolean)).has(message?.type);
}

async function handleManagedRuntimeMessage(host, message, sender) {
  let result;
  let logicalAgentId = sender?.agentId || null;

  if (isAdapterOwnedMessage(host, message)) {
    result = await host.agentPool.handleContentMessage(message, sender);
    logicalAgentId = result?.agentId || logicalAgentId;
    if (logicalAgentId) await host.orchestrator.handleAgentStateChanged(logicalAgentId);
  } else {
    const portableSender = host.agentPool.portableSender(sender);
    result = await host.orchestrator.handleRuntimeMessage(message, portableSender);
  }

  host.noteManagedBrowserRuntimeMessage?.(message, sender, result);
  if (logicalAgentId) {
    const agent = host.agentRuntime.getAgent(logicalAgentId);
    if (agent) await host.integrationEngine.handleAgentStateChanged(agent);
  }
  await host.recoveryController.tick({ reason: `direct-browser:${message?.type || "runtime_message"}` });
  return result;
}

async function handleManagedApiMessage(host, message, sender) {
  if (sender?.sessionId) {
    return {
      apiVersion: host.root.ORCHESTRATOR_API_VERSION,
      ok: false,
      reason: "orchestrator_command_forbidden_from_agent"
    };
  }
  const TYPES = host.root.MESSAGE_TYPES || {};
  const payload = message?.payload || {};
  if (message?.type === TYPES.ORCHESTRATOR_API_QUERY) return host.query(payload.name, payload.payload || {});
  if (message?.type === TYPES.ORCHESTRATOR_API_EXECUTE) return host.execute(payload.name, payload.payload || {});
  return host.orchestratorApi.handleLegacyMessage(message, host.agentPool.portableSender(sender || {}));
}

async function handleManagedSessionRemoved(host, sessionId) {
  const agent = host.agentRuntime.getAgentBySessionId(sessionId);
  host.noteManagedBrowserSessionRemoved?.(agent);
  const removed = await host.agentPool.handleBindingRemoved(sessionId, "session_closed");
  if (removed?.agentId) {
    await host.orchestrator.handleAgentUnavailable(removed.agentId, "runtime_binding_lost");
    await host.integrationEngine.handleAgentUnavailable(removed.agentId, "runtime_binding_lost");
  }
  await host.recoveryController.tick({ reason: "direct-browser:binding_removed" });
  return { ok: true };
}

async function handleManagedSessionUpdated(host, sessionId, changeInfo, session) {
  const updated = await host.agentPool.handleBindingUpdated(sessionId, changeInfo || {}, session || null);
  if (updated?.agentId) {
    await host.orchestrator.handleAgentStateChanged(updated.agentId);
    const agent = host.agentRuntime.getAgent(updated.agentId);
    if (agent) await host.integrationEngine.handleAgentStateChanged(agent);
  }
  await host.recoveryController.tick({ reason: "direct-browser:binding_updated" });
  return { ok: true };
}

function bindManagedBrowserAgentRuntime(host) {
  if (typeof host?.agentRuntime?.bindHostHandlers !== "function") return null;
  return host.agentRuntime.bindHostHandlers({
    onRuntimeMessage: (message, sender) => handleManagedRuntimeMessage(host, message, sender),
    onApiMessage: (message, sender) => handleManagedApiMessage(host, message, sender),
    onSessionRemoved: (sessionId) => handleManagedSessionRemoved(host, sessionId),
    onSessionUpdated: (sessionId, changeInfo, session) => handleManagedSessionUpdated(host, sessionId, changeInfo, session)
  });
}

module.exports = {
  bindManagedBrowserAgentRuntime,
  handleManagedRuntimeMessage,
  handleManagedApiMessage,
  handleManagedSessionRemoved,
  handleManagedSessionUpdated
};
