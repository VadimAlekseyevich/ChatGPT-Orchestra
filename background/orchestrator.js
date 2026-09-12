(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};
  const CHATGPT_HOME = "https://chatgpt.com/";
  const MAX_WORKERS = 4;

  function asError(error) {
    return error?.message || String(error || "unknown_error");
  }

  root.PHASE2_MAX_WORKERS = MAX_WORKERS;
  root.PHASE2_CHATGPT_HOME = CHATGPT_HOME;
  root.phase2AsError = asError;
})();
