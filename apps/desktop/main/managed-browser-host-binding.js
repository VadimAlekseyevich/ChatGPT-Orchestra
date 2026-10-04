"use strict";

async function handleManagedRuntimeMessage(host, message, sender) {
  const result = await host.orchestrator.handleRuntimeMessage(message, sender);
  host.noteManagedBrowserRuntimeMessage?.(message, sender, result);
  if (sender?.agentId) {
    const agent = host.agentRuntime.getAgent(sender.agentId);
    if (agent) await host.integrationEngine.handleAgentStateChanged(agent);
  }
  await host.recoveryController.tick({ reason: `direct-browser:${message?.type || "runtime_message"}` });
  return result;
}

async function handleManagedApiMessage(host, message, sender) {
  if (sender?.agentId) {
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
  return host.orchestratorApi.handleLegacyMessage(message, sender || {});
}

async function handleManagedSessionRemoved(host, sessionId) {
  const agent = host.agentRuntime.getAgentBySessionId(sessionId);
  host.noteManagedBrowserSessionRemoved?.(agent);
  await host.agentRuntime.markSessionOffline(sessionId, "session_closed");
  if (agent?.role === "lead") await host.planningEngine?.handleAgentUnavailable?.(agent.agentId, "session_closed");
  if (agent) {
    await host.schedulerEngine?.handleAgentUnavailable?.(agent.agentId, "session_closed");
    await host.integrationEngine.handleAgentUnavailable(agent.agentId, "session_closed");
  }
  await host.recoveryController.tick({ reason: "direct-browser:session_removed" });
  return { ok: true };
}

async function handleManagedSessionUpdated(host, sessionId, changeInfo, session) {
  if (changeInfo?.url) await host.agentRuntime.updateSessionNavigation(sessionId, changeInfo.url);
  let agent = host.agentRuntime.getAgentBySessionId(sessionId);
  if (agent && changeInfo?.status === "complete") {
    const refreshed = await host.agentRuntime.refreshAgent(agent.agentId);
    agent = refreshed?.agent || host.agentRuntime.getAgent(agent.agentId);
  }
  if (agent) await host.integrationEngine.handleAgentStateChanged(agent);
  await host.recoveryController.tick({ reason: "direct-browser:session_updated" });
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
