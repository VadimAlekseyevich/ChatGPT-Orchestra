(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};
  const Utils = root.Utils || (typeof require === "function" ? require("./utils.js") : null);
  const OrchestraProtocol = root.OrchestraProtocol
    || (typeof require === "function" ? require("../protocol/orchestra-protocol.js") : null);

  class ProtocolParser {
    constructor({ maxEnvelopeLength = OrchestraProtocol?.MAX_ENVELOPE_LENGTH || 4096 } = {}) {
      this.maxEnvelopeLength = Math.max(128, Number(maxEnvelopeLength) || 4096);
    }

    parse(text, { rules = [] } = {}) {
      const normalizedText = Utils.normalizeText(text);
      const lastLine = Utils.getLastNonEmptyLine(normalizedText);

      if (!lastLine) {
        return { kind: "none", lastLine: "" };
      }

      if (lastLine.startsWith(OrchestraProtocol.PREFIX)) {
        const parsed = OrchestraProtocol.parseLine(lastLine, {
          maxEnvelopeLength: this.maxEnvelopeLength
        });
        if (!parsed.ok) {
          return {
            kind: "protocol_error",
            lastLine,
            reason: parsed.reason,
            field: parsed.field || null,
            received: parsed.received ?? null
          };
        }
        return {
          kind: "orchestra_event",
          lastLine,
          event: parsed.event,
          route: OrchestraProtocol.routeForEvent(parsed.event.event)
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
