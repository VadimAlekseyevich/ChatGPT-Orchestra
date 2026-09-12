(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};
  const PREFIX = "[ChatGPT Orchestra]";

  function normalizeDetails(details) {
    if (details == null) return undefined;
    if (details instanceof Error) {
      return { name: details.name, message: details.message, stack: details.stack };
    }
    return details;
  }

  function write(level, event, details) {
    const record = {
      ts: new Date().toISOString(),
      level,
      event: String(event || "unknown"),
      details: normalizeDetails(details)
    };

    const method = level === "error"
      ? console.error
      : level === "warn"
        ? console.warn
        : level === "info"
          ? console.info
          : console.debug;

    method(PREFIX, record);
    return record;
  }

  root.Logger = Object.freeze({
    debug: (event, details) => write("debug", event, details),
    info: (event, details) => write("info", event, details),
    warn: (event, details) => write("warn", event, details),
    error: (event, details) => write("error", event, details)
  });

  if (typeof module !== "undefined" && module.exports) {
    module.exports = root.Logger;
  }
})();
