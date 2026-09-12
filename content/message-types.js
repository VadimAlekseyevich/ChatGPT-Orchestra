(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};

  root.MESSAGE_TYPES = Object.freeze({
    CONTENT_READY: "orchestra/content-ready",
    CHAT_STATE: "orchestra/chat-state",
    ASSISTANT_RESPONSE_COMPLETED: "orchestra/assistant-response-completed",
    SEND_PROMPT: "orchestra/send-prompt",
    STOP_GENERATION: "orchestra/stop-generation",
    PING: "orchestra/ping",
    PONG: "orchestra/pong"
  });

  if (typeof module !== "undefined" && module.exports) {
    module.exports = root.MESSAGE_TYPES;
  }
})();
