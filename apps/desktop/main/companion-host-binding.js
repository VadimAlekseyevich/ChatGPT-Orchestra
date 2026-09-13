"use strict";

async function handleRuntimeMessage(host, message, sender) {
  const result = await host.orchestrator.handleRuntimeMessage(message, sender);
  if (sender?.agentId) {
    const agent = host.agentRuntime.getAgent(sender.agentId);
    if (agent) await host.integrationEngine.handleAgentStateChanged(agent);
  }
  await host.recoveryController.tick({ reason: `companion:${message?.type || "runtime_message"}` });
  return result;
}

async function handleLegacyMessage(host, message, sender) {
  const result = await host.orchestratorApi.handleLegacyMessage(message, sender || {});
  await host.recoveryController.tick({ reason: `companion_ui:${message?.type || "legacy_message"}` });
  return result;
}

async function handleSessionRemoved(host, sessionId) {
  const agent = host.agentRuntime.getAgentBySessionId(sessionId);
  await host.orchestrator.handleSessionRemoved(sessionId);
  if (agent) await host.integrationEngine.handleAgentUnavailable(agent.agentId, "session_closed");
  await host.recoveryController.tick({ reason: "companion:session_removed" });
  return { ok: true };
}

async function handleSessionUpdated(host, sessionId, changeInfo, session) {
  await host.orchestrator.handleSessionUpdated(sessionId, changeInfo || {}, session || null);
  const agent = host.agentRuntime.getAgentBySessionId(sessionId);
  if (agent) await host.integrationEngine.handleAgentStateChanged(agent);
  await host.recoveryController.tick({ reason: "companion:session_updated" });
  return { ok: true };
}

function bindCompanionAgentRuntime(host) {
  if (typeof host?.agentRuntime?.bindHostHandlers !== "function") return null;
  const unbindRuntime = host.agentRuntime.bindHostHandlers({
    onRuntimeMessage: (message, sender) => handleRuntimeMessage(host, message, sender),
    onSessionRemoved: (sessionId) => handleSessionRemoved(host, sessionId),
    onSessionUpdated: (sessionId, changeInfo, session) => handleSessionUpdated(host, sessionId, changeInfo, session)
  });
  const unbindLegacy = host.agentRuntime.rpc?.onRequest?.("orchestrator.legacyMessage", ({ message, sender } = {}) => {
    return handleLegacyMessage(host, message, host.agentRuntime.normalizeSender(sender));
  }) || (() => {});
  return () => {
    unbindLegacy();
    unbindRuntime?.();
  };
}

module.exports = { bindCompanionAgentRuntime, handleRuntimeMessage, handleLegacyMessage, handleSessionRemoved, handleSessionUpdated };
