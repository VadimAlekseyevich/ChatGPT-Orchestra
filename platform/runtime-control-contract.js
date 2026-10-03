(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};
  const RUNTIME_CONTROL_METHODS = Object.freeze([
    "getAgentBySessionId",
    "sessionIdForAgent",
    "getActiveSession",
    "getSession",
    "createSession",
    "navigateSession",
    "removeSession",
    "bindAgentToSession",
    "createAgentForSession",
    "markSessionOffline",
    "updateSessionNavigation",
    "updateHeartbeat",
    "normalizeSender"
  ]);

  function assertRuntimeControl(value) {
    const missing = RUNTIME_CONTROL_METHODS.filter((method) => typeof value?.[method] !== "function");
    if (missing.length) throw new TypeError(`runtime_control_contract_missing:${missing.join(",")}`);
    return value;
  }

  root.RuntimeControlContract = { RUNTIME_CONTROL_METHODS, assertRuntimeControl };
  if (typeof module !== "undefined" && module.exports) module.exports = root.RuntimeControlContract;
})();
