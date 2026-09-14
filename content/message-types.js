(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};

  root.MESSAGE_TYPES = Object.freeze({
    CONTENT_READY: "orchestra/content-ready",
    CONTENT_HEARTBEAT: "orchestra/content-heartbeat",
    CHAT_STATE: "orchestra/chat-state",
    ASSISTANT_RESPONSE_COMPLETED: "orchestra/assistant-response-completed",
    ORCHESTRA_EVENT: "orchestra/protocol-event",
    PROTOCOL_ERROR: "orchestra/protocol-error",

    SEND_PROMPT: "orchestra/send-prompt",
    STOP_GENERATION: "orchestra/stop-generation",
    PING: "orchestra/ping",
    PONG: "orchestra/pong",

    COMPANION_GET_STATUS: "orchestra/companion-get-status",
    COMPANION_ENABLE: "orchestra/companion-enable",
    COMPANION_DISABLE: "orchestra/companion-disable",
    COMPANION_RECONNECT: "orchestra/companion-reconnect",
    COMPANION_MIGRATE_PROJECT: "orchestra/companion-migrate-project",
    COMPANION_GET_MIGRATION_STATUS: "orchestra/companion-get-migration-status",

    ORCHESTRATOR_API_QUERY: "orchestra/api-query",
    ORCHESTRATOR_API_EXECUTE: "orchestra/api-execute",
    ORCHESTRATOR_GET_STATE: "orchestra/orchestrator-get-state",
    ORCHESTRATOR_GET_EVENTS: "orchestra/orchestrator-get-events",
    ORCHESTRATOR_GET_PROJECT: "orchestra/orchestrator-get-project",
    ORCHESTRATOR_START_PROJECT: "orchestra/orchestrator-start-project",
    ORCHESTRATOR_GET_SCHEDULER: "orchestra/orchestrator-get-scheduler",
    ORCHESTRATOR_GET_SCHEDULER_DECISIONS: "orchestra/orchestrator-get-scheduler-decisions",
    ORCHESTRATOR_START_EXECUTION: "orchestra/orchestrator-start-execution",
    ORCHESTRATOR_SCHEDULER_TICK: "orchestra/orchestrator-scheduler-tick",
    ORCHESTRATOR_GET_RECOVERY: "orchestra/orchestrator-get-recovery",
    ORCHESTRATOR_PAUSE: "orchestra/orchestrator-pause",
    ORCHESTRATOR_STOP_NOW: "orchestra/orchestrator-stop-now",
    ORCHESTRATOR_RESUME: "orchestra/orchestrator-resume",
    ORCHESTRATOR_GET_PERSISTENCE: "orchestra/orchestrator-get-persistence",
    ORCHESTRATOR_EXPORT_PROJECT: "orchestra/orchestrator-export-project",
    ORCHESTRATOR_IMPORT_PROJECT: "orchestra/orchestrator-import-project",
    ORCHESTRATOR_REGISTER_ACTIVE_LEAD: "orchestra/orchestrator-register-active-lead",
    ORCHESTRATOR_CREATE_WORKERS: "orchestra/orchestrator-create-workers",
    ORCHESTRATOR_BIND_PROTOCOL_CONTEXT: "orchestra/orchestrator-bind-protocol-context",
    ORCHESTRATOR_CLEAR_PROTOCOL_CONTEXT: "orchestra/orchestrator-clear-protocol-context",
    ORCHESTRATOR_SEND_AGENT_PROMPT: "orchestra/orchestrator-send-agent-prompt",
    ORCHESTRATOR_STOP_AGENT: "orchestra/orchestrator-stop-agent"
  });

  if (typeof module !== "undefined" && module.exports) module.exports = root.MESSAGE_TYPES;
})();
