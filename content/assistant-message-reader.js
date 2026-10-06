(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};
  const AssistantTurnTracker = root.AssistantTurnTracker
    || (typeof require === "function" ? require("./assistant-turn-tracker.js") : null);
  const SELECTORS = root.SELECTORS || (typeof require === "function" ? require("./selectors.js") : null);

  class AssistantMessageReader {
    constructor({ documentRef = globalThis.document, locationRef = globalThis.location, tracker = null } = {}) {
      this.documentRef = documentRef;
      this.locationRef = locationRef;
      this.tracker = tracker || new AssistantTurnTracker({
        documentRef,
        locationRef,
        selectors: SELECTORS
      });
    }

    normalizeMessageElement(element) {
      return this.tracker.resolveCanonicalElement(element);
    }

    getMessages() {
      return this.tracker.getCanonicalTurnElements();
    }

    getLastMessageElement() {
      return this.getMessages().at(-1) || null;
    }

    getMessageText(element) {
      return this.tracker.extractText(element);
    }

    getLastAssistantText() {
      return this.getMessageText(this.getLastMessageElement());
    }

    getSnapshot() {
      const snapshot = this.tracker.getSnapshot();
      if (!snapshot?.ok) {
        return {
          ok: false,
          reason: snapshot?.reason || "assistant_turn_snapshot_failed",
          text: "",
          messageCount: Math.max(0, Number(snapshot?.mountedTurnCount) || 0),
          pathname: String(snapshot?.conversationKey || this.locationRef?.pathname || ""),
          conversationKey: String(snapshot?.conversationKey || this.locationRef?.pathname || ""),
          fingerprint: "",
          turnId: "",
          latestTurnId: "",
          latestTextFingerprint: "",
          textFingerprint: "",
          observedTurnCount: Math.max(0, Number(snapshot?.assistantTurnCountObserved) || 0),
          identitySource: "",
          turnChanged: false,
          textChanged: false,
          conversationChanged: Boolean(snapshot?.conversationChanged),
          hydrationCandidate: false
        };
      }

      return {
        ok: true,
        text: snapshot.latestText,
        messageCount: snapshot.mountedTurnCount,
        pathname: snapshot.conversationKey,
        conversationKey: snapshot.conversationKey,
        fingerprint: snapshot.responseFingerprint,
        turnId: snapshot.latestTurnId,
        latestTurnId: snapshot.latestTurnId,
        latestTextFingerprint: snapshot.latestTextFingerprint,
        textFingerprint: snapshot.latestTextFingerprint,
        observedTurnCount: snapshot.assistantTurnCountObserved,
        identitySource: snapshot.latestIdentitySource,
        turnChanged: snapshot.turnChanged,
        textChanged: snapshot.textChanged,
        conversationChanged: snapshot.conversationChanged,
        hydrationCandidate: snapshot.hydrationCandidate
      };
    }
  }

  root.AssistantMessageReader = AssistantMessageReader;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = AssistantMessageReader;
  }
})();
