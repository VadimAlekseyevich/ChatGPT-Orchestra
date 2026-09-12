(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};
  const Utils = root.Utils || (typeof require === "function" ? require("./utils.js") : null);

  class ProtocolParser {
    constructor({ maxEnvelopeLength = 4096 } = {}) {
      this.maxEnvelopeLength = Math.max(128, Number(maxEnvelopeLength) || 4096);
    }

    parse(text, { rules = [] } = {}) {
      const normalizedText = Utils.normalizeText(text);
      const lastLine = Utils.getLastNonEmptyLine(normalizedText);

      if (!lastLine) {
        return { kind: "none", lastLine: "" };
      }

      if (lastLine.startsWith("@@ORCH")) {
        return {
          kind: "orchestra_candidate",
          lastLine,
          raw: lastLine.slice(0, this.maxEnvelopeLength),
          truncated: lastLine.length > this.maxEnvelopeLength
        };
      }

      const rule = (rules || []).find((candidate) => (
        candidate
        && candidate.enabled !== false
        && String(candidate.marker || "").trim() === lastLine
      ));

      if (rule) {
        return {
          kind: "legacy_rule",
          lastLine,
          rule
        };
      }

      return {
        kind: "unrecognized",
        lastLine
      };
    }
  }

  root.ProtocolParser = ProtocolParser;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = ProtocolParser;
  }
})();
