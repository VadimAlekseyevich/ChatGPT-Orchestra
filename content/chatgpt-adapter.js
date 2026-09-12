(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};

  class ChatGPTAdapter {
    constructor({
      documentRef = globalThis.document,
      windowRef = globalThis.window,
      locationRef = globalThis.location,
      logger = root.Logger,
      quietMs = 700,
      pollMs = 500,
      sendTimeoutMs = 5000
    } = {}) {
      this.logger = logger;
      this.reader = new root.AssistantMessageReader({ documentRef, locationRef });
      this.composer = new root.ComposerAdapter({ documentRef, windowRef, sendTimeoutMs });
      this.parser = new root.ProtocolParser();
      this.messenger = new root.RuntimeMessenger({ logger });
      this.detector = new root.GenerationDetector({
        documentRef,
        windowRef,
        reader: this.reader,
        composer: this.composer,
        logger,
        quietMs,
        pollMs
      });
      this.unsubscribeDetector = null;
    }

    configure({ quietMs, sendTimeoutMs } = {}) {
      if (quietMs != null) this.detector.setQuietMs(quietMs);
      if (sendTimeoutMs != null) this.composer.setSendTimeoutMs(sendTimeoutMs);
    }

    start(onGenerationEvent) {
      if (this.unsubscribeDetector) this.unsubscribeDetector();
      if (typeof onGenerationEvent === "function") {
        this.unsubscribeDetector = this.detector.onEvent(onGenerationEvent);
      }
      this.detector.start();
      this.messenger.send(root.MESSAGE_TYPES.CONTENT_READY, this.getStatus());
    }

    stop() {
      this.detector.stop();
      this.unsubscribeDetector?.();
      this.unsubscribeDetector = null;
    }

    getStatus() {
      const response = this.reader.getSnapshot();
      return {
        availability: this.composer.getAvailability(),
        generating: this.composer.isGenerating(),
        responseFingerprint: response.fingerprint,
        messageCount: response.messageCount,
        pathname: response.pathname,
        detector: this.detector.machine.snapshot()
      };
    }

    getResponseSnapshot() {
      return this.reader.getSnapshot();
    }

    parseResponse(text, options) {
      return this.parser.parse(text, options);
    }

    parseLastResponse(options) {
      return this.parser.parse(this.reader.getLastAssistantText(), options);
    }

    isGenerating() {
      return this.composer.isGenerating();
    }

    async sendPrompt(prompt) {
      return this.composer.sendPrompt(prompt);
    }

    stopGeneration() {
      return this.composer.stopGeneration();
    }
  }

  root.ChatGPTAdapter = ChatGPTAdapter;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = ChatGPTAdapter;
  }
})();
