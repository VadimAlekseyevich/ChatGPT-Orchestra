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

    getMessages() {
      for (const selector of SELECTORS.assistantMessages) {
        const messages = Array.from(this.documentRef?.querySelectorAll?.(selector) || []);
        if (messages.length) return messages;
      }
      return [];
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
