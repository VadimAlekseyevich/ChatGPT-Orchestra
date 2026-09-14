"use strict";

const { STORE_KEYS } = require("../../../persistence/portable-state.js");
const { stageCompanionMigration, migrationStatus } = require("./companion-migration.js");

async function handleRuntimeMessage(host, message, sender) {
  const result = await host.orchestrator.handleRuntimeMessage(message, sender);
  if (sender?.agentId) {
    const agent = host.agentRuntime.getAgent(sender.agentId);
    if (agent) await host.integrationEngine.handleAgentStateChanged(agent);
  }
  await host.recoveryController.tick({ reason: `companion:${message?.type || "runtime_message"}` });
  return result;
}

async function handleApiMessage(host, message, sender) {
  if (sender?.sessionId) return { apiVersion: host.root.ORCHESTRATOR_API_VERSION, ok: false, reason: "orchestrator_command_forbidden_from_agent_session" };
  const TYPES = host.root.MESSAGE_TYPES || {};
  const payload = message?.payload || {};
  if (message?.type === TYPES.ORCHESTRATOR_API_QUERY) return host.query(payload.name, payload.payload || {});
  if (message?.type === TYPES.ORCHESTRATOR_API_EXECUTE) return host.execute(payload.name, payload.payload || {});
  return host.orchestratorApi.handleLegacyMessage(message, sender || {});
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

async function handleMigrationStage(host, bundle) {
  const checked = host.projectBundleService?.validateBundle?.(bundle);
  if (!checked?.ok) return checked || { ok: false, reason: "project_bundle_invalid" };
  const current = await host.stateStore.get(STORE_KEYS.projects);
  const activeProjectId = String(current?.[STORE_KEYS.projects]?.activeProjectId || "");
  if (activeProjectId && activeProjectId !== checked.projectId) {
    return {
      ok: false,
      reason: "companion_migration_destination_busy",
      activeProjectId,
      incomingProjectId: checked.projectId
    };
  }
  return stageCompanionMigration({
    paths: host.paths,
    bundle,
    validateBundle: (input) => host.projectBundleService.validateBundle(input),
    clock: host.clock
  });
}

function bindCompanionAgentRuntime(host) {
  if (typeof host?.agentRuntime?.bindHostHandlers !== "function") return null;
  const disposers = [];
  const runtimeUnbind = host.agentRuntime.bindHostHandlers({
    onRuntimeMessage: (message, sender) => handleRuntimeMessage(host, message, sender),
    onApiMessage: (message, sender) => handleApiMessage(host, message, sender),
    onSessionRemoved: (sessionId) => handleSessionRemoved(host, sessionId),
    onSessionUpdated: (sessionId, changeInfo, session) => handleSessionUpdated(host, sessionId, changeInfo, session)
  });
  if (typeof runtimeUnbind === "function") disposers.push(runtimeUnbind);

  const rpc = host.agentRuntime.rpc;
  if (rpc?.onRequest) {
    disposers.push(rpc.onRequest("migration.stageBundle", ({ bundle } = {}) => handleMigrationStage(host, bundle)));
    disposers.push(rpc.onRequest("migration.status", () => ({ ok: true, ...migrationStatus(host.paths) })));
  }

  return () => {
    for (const dispose of disposers.splice(0)) {
      try { dispose?.(); } catch (_) {}
    }
  };
}

module.exports = {
  bindCompanionAgentRuntime,
  handleRuntimeMessage,
  handleApiMessage,
  handleSessionRemoved,
  handleSessionUpdated,
  handleMigrationStage
};
