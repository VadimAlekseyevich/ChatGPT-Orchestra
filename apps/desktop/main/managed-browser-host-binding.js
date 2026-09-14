"use strict";

async function handleManagedRuntimeMessage(host, message, sender) {
  const result = await host.orchestrator.handleRuntimeMessage(message, sender);
  if (sender?.agentId) {
    const agent = host.agentRuntime.getAgent(sender.agentId);
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
      reason: "orchestrator_command_forbidden_from_agent_session"
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
  await host.orchestrator.handleSessionRemoved(sessionId);
  if (agent) await host.integrationEngine.handleAgentUnavailable(agent.agentId, "session_closed");
  await host.recoveryController.tick({ reason: "direct-browser:session_removed" });
  return { ok: true };
}

async function handleManagedSessionUpdated(host, sessionId, changeInfo, session) {
  await host.orchestrator.handleSessionUpdated(sessionId, changeInfo || {}, session || null);
  const agent = host.agentRuntime.getAgentBySessionId(sessionId);
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
