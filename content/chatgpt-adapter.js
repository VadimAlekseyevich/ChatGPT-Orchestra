(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};

  class ChatGPTAdapter {
    constructor({ documentRef = globalThis.document, windowRef = globalThis.window, locationRef = globalThis.location, logger = root.Logger, quietMs = 700, pollMs = 500, sendTimeoutMs = 5000, heartbeatMs = 5000 } = {}) {
      this.logger = logger;
      this.reader = new root.AssistantMessageReader({ documentRef, locationRef });
      this.composer = new root.ComposerAdapter({ documentRef, windowRef, sendTimeoutMs });
      this.parser = new root.ProtocolParser();
      this.messenger = new root.RuntimeMessenger({ logger });
      this.detector = new root.GenerationDetector({ documentRef, windowRef, reader: this.reader, composer: this.composer, logger, quietMs, pollMs });
      this.heartbeatMs = Math.max(2000, Number(heartbeatMs) || 5000);
      this.heartbeatHandle = null;
      this.registeredAgentId = null;
      this.unsubscribeExternalDetector = null;
      this.unsubscribeRuntimeDetector = null;
    }

    configure({ quietMs, sendTimeoutMs } = {}) {
      if (quietMs != null) this.detector.setQuietMs(quietMs);
      if (sendTimeoutMs != null) this.composer.setSendTimeoutMs(sendTimeoutMs);
    }

    bindAgent(agentId) {
      const normalized = String(agentId || "").trim();
      if (!normalized) return false;
      this.registeredAgentId = normalized;
      this.enableHeartbeat();
      return true;
    }

    sendHeartbeat() {
      if (!this.registeredAgentId) return;
      this.messenger.send(root.MESSAGE_TYPES.CONTENT_HEARTBEAT, { ...this.getStatus(), agentId: this.registeredAgentId });
    }

    enableHeartbeat() {
      if (!this.registeredAgentId || this.heartbeatHandle) return;
      this.sendHeartbeat();
      this.heartbeatHandle = setInterval(() => this.sendHeartbeat(), this.heartbeatMs);
      this.logger?.debug?.("agent_heartbeat_enabled", { heartbeatMs: this.heartbeatMs, agentId: this.registeredAgentId });
    }

    disableHeartbeat() {
      if (this.heartbeatHandle) clearInterval(this.heartbeatHandle);
      this.heartbeatHandle = null;
    }

    async announceReady() {
      const response = await this.messenger.request(root.MESSAGE_TYPES.CONTENT_READY, this.getStatus());
      if (response?.agent?.agentId) this.bindAgent(response.agent.agentId);
      return response;
    }

    async publishProtocolResult(snapshot) {
      if (!this.registeredAgentId || !snapshot?.text) return;
      const parsed = this.parser.parse(snapshot.text);

      if (parsed.kind === "orchestra_event") {
        if (parsed.event.agentId !== this.registeredAgentId) {
          this.messenger.send(root.MESSAGE_TYPES.PROTOCOL_ERROR, {
            reason: "agent_mismatch_content",
            received: parsed.event.agentId,
            expectedAgentId: this.registeredAgentId,
            responseFingerprint: snapshot.fingerprint,
            lastLine: parsed.lastLine
          });
          return;
        }

        let planningArtifact = null;
        let submittedEvent = parsed.event;
        if (String(parsed.event.taskId || "").startsWith("planning:") && parsed.event.event === "DONE") {
          const artifactResult = root.PlanningArtifactParser?.parsePlanningArtifact(snapshot.text);
          if (!artifactResult?.ok) {
            this.messenger.send(root.MESSAGE_TYPES.PROTOCOL_ERROR, {
              reason: artifactResult?.reason || "planning_artifact_parser_unavailable",
              responseFingerprint: snapshot.fingerprint,
              lastLine: parsed.lastLine
            });
            return;
          }
          planningArtifact = artifactResult.artifact;
          submittedEvent = {
            ...parsed.event,
            payload: {
              ...(parsed.event.payload || {}),
              artifactSignature: artifactResult.signature
            }
          };
        }

        const response = await this.messenger.request(root.MESSAGE_TYPES.ORCHESTRA_EVENT, {
          event: submittedEvent,
          responseFingerprint: snapshot.fingerprint,
          pathname: snapshot.pathname,
          messageCount: snapshot.messageCount,
          planningArtifact
        });
        this.logger?.info?.("orchestra_protocol_event_submitted", {
          eventId: submittedEvent.eventId,
          event: submittedEvent.event,
          accepted: Boolean(response?.accepted),
          duplicate: Boolean(response?.duplicate),
          reason: response?.reason || null
        });
        return;
      }

      if (parsed.kind === "protocol_error") {
        this.messenger.send(root.MESSAGE_TYPES.PROTOCOL_ERROR, {
          reason: parsed.reason,
          field: parsed.field,
          received: parsed.received,
          responseFingerprint: snapshot.fingerprint,
          lastLine: parsed.lastLine
        });
      }
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
          this.publishProtocolResult(event.snapshot).catch((error) => {
            this.logger?.warn?.("protocol_publish_failed", { message: error?.message || String(error) });
          });
        }

        if (event.type === "generation_started" || event.type === "generation_stopped" || event.type === "generation_completed") {
          this.messenger.send(root.MESSAGE_TYPES.CHAT_STATE, this.getStatus());
        }
      });

      if (typeof onGenerationEvent === "function") this.unsubscribeExternalDetector = this.detector.onEvent(onGenerationEvent);
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
  if (typeof module !== "undefined" && module.exports) module.exports = ChatGPTAdapter;
})();