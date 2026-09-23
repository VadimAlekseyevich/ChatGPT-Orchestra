(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};
  const Utils = root.Utils || (typeof require === "function" ? require("./utils.js") : null);
  const SELECTORS = root.SELECTORS || (typeof require === "function" ? require("./selectors.js") : null);

  class AssistantMessageReader {
    constructor({ documentRef = globalThis.document, locationRef = globalThis.location } = {}) {
      this.documentRef = documentRef;
      this.locationRef = locationRef;
    }

    normalizeMessageElement(element) {
      if (!element) return null;
      try {
        return element.closest?.('[data-testid^="conversation-turn-"], article[data-turn="assistant"], section[data-turn="assistant"]') || element;
      } catch (_) {
        return element;
      }
    }

    getMessages() {
      const messages = [];
      const seen = new Set();
      for (const selector of SELECTORS.assistantMessages) {
        let current = [];
        try {
          current = Array.from(this.documentRef?.querySelectorAll?.(selector) || []);
        } catch (_) {
          current = [];
        }
        for (const element of current) {
          const normalized = this.normalizeMessageElement(element);
          if (!normalized || seen.has(normalized)) continue;
          seen.add(normalized);
          messages.push(normalized);
        }
      }
      messages.sort((left, right) => {
        if (left === right || typeof left?.compareDocumentPosition !== "function") return 0;
        try {
          const position = left.compareDocumentPosition(right);
          if (position & 4) return -1;
          if (position & 2) return 1;
        } catch (_) {}
        return 0;
      });
      return messages;
    }

    getLastMessageElement() {
      return this.getMessages().at(-1) || null;
    }

    getMessageText(element) {
      if (!element) return "";

      let body = null;
      for (const selector of SELECTORS.assistantBodies) {
        body = element.querySelector?.(selector);
        if (body) break;
      }

      const source = body || element;
      return Utils.normalizeText(source.innerText || source.textContent || "");
    }

    getLastAssistantText() {
      return this.getMessageText(this.getLastMessageElement());
    }

    getSnapshot() {
      const messages = this.getMessages();
      const last = messages.at(-1) || null;
      const text = this.getMessageText(last);
      const messageCount = messages.length;
      const pathname = String(this.locationRef?.pathname || "");
      const fingerprint = text
        ? Utils.hashString(`${pathname}:${messageCount}:${text}`)
        : "";

      return {
        text,
        messageCount,
        pathname,
        fingerprint
      };
    }
  }

  root.AssistantMessageReader = AssistantMessageReader;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = AssistantMessageReader;
  }
})();
