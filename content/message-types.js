(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};

  root.MESSAGE_TYPES = Object.freeze({
    CONTENT_READY: "orchestra/content-ready",
    CONTENT_HEARTBEAT: "orchestra/content-heartbeat",
    CHAT_STATE: "orchestra/chat-state",
    ASSISTANT_RESPONSE_COMPLETED: "orchestra/assistant-response-completed",

    SEND_PROMPT: "orchestra/send-prompt",
    STOP_GENERATION: "orchestra/stop-generation",
    PING: "orchestra/ping",
    PONG: "orchestra/pong",

    ORCHESTRATOR_GET_STATE: "orchestra/orchestrator-get-state",
    ORCHESTRATOR_REGISTER_ACTIVE_LEAD: "orchestra/orchestrator-register-active-lead",
    ORCHESTRATOR_CREATE_WORKERS: "orchestra/orchestrator-create-workers",
    ORCHESTRATOR_SEND_AGENT_PROMPT: "orchestra/orchestrator-send-agent-prompt",
    ORCHESTRATOR_STOP_AGENT: "orchestra/orchestrator-stop-agent"
  });

  if (typeof module !== "undefined" && module.exports) {
    module.exports = root.MESSAGE_TYPES;
  }
})();
