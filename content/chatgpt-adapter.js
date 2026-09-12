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
      sendTimeoutMs = 5000,
      heartbeatMs = 5000
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
      this.heartbeatMs = Math.max(2000, Number(heartbeatMs) || 5000);
      this.heartbeatHandle = null;
      this.unsubscribeExternalDetector = null;
      this.unsubscribeRuntimeDetector = null;
    }

    configure({ quietMs, sendTimeoutMs } = {}) {
      if (quietMs != null) this.detector.setQuietMs(quietMs);
      if (sendTimeoutMs != null) this.composer.setSendTimeoutMs(sendTimeoutMs);
    }

    sendHeartbeat() {
      this.messenger.send(root.MESSAGE_TYPES.CONTENT_HEARTBEAT, this.getStatus());
    }

    enableHeartbeat() {
      if (this.heartbeatHandle) return;
      this.sendHeartbeat();
      this.heartbeatHandle = setInterval(() => this.sendHeartbeat(), this.heartbeatMs);
      this.logger?.debug?.("agent_heartbeat_enabled", { heartbeatMs: this.heartbeatMs });
    }

    disableHeartbeat() {
      if (this.heartbeatHandle) clearInterval(this.heartbeatHandle);
      this.heartbeatHandle = null;
    }

    async announceReady() {
      const response = await this.messenger.request(root.MESSAGE_TYPES.CONTENT_READY, this.getStatus());
      if (response?.agent?.agentId) this.enableHeartbeat();
      return response;
    }

    start(onGenerationEvent) {
      this.unsubscribeExternalDetector?.();
      this.unsubscribeRuntimeDetector?.();
      this.unsubscribeExternalDetector = null;
      this.unsubscribeRuntimeDetector = null;

      this.unsubscribeRuntimeDetector = this.detector.onEvent((event) => {
        if (event.type === "generation_completed") {
          this.messenger.send(root.MESSAGE_TYPES.ASSISTANT_RESPONSE_COMPLETED, {
            ...this.getStatus(),
            fingerprint: event.snapshot?.fingerprint || "",
            messageCount: event.snapshot?.messageCount || 0,
            pathname: event.snapshot?.pathname || ""
          });
        }

        if (
          event.type === "generation_started"
          || event.type === "generation_stopped"
          || event.type === "generation_completed"
        ) {
          this.messenger.send(root.MESSAGE_TYPES.CHAT_STATE, this.getStatus());
        }
      });

      if (typeof onGenerationEvent === "function") {
        this.unsubscribeExternalDetector = this.detector.onEvent(onGenerationEvent);
      }

      this.detector.start();
      this.announceReady().catch((error) => {
        this.logger?.debug?.("content_ready_handshake_failed", { message: error?.message || String(error) });
      });
    }

    stop() {
      this.detector.stop();
      this.disableHeartbeat();
      this.unsubscribeExternalDetector?.();
      this.unsubscribeRuntimeDetector?.();
      this.unsubscribeExternalDetector = null;
      this.unsubscribeRuntimeDetector = null;
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

    getResponseSnapshot() { return this.reader.getSnapshot(); }
    parseResponse(text, options) { return this.parser.parse(text, options); }
    parseLastResponse(options) { return this.parser.parse(this.reader.getLastAssistantText(), options); }
    isGenerating() { return this.composer.isGenerating(); }
    async sendPrompt(prompt) { return this.composer.sendPrompt(prompt); }
    stopGeneration() { return this.composer.stopGeneration(); }
  }

  root.ChatGPTAdapter = ChatGPTAdapter;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = ChatGPTAdapter;
  }
})();
