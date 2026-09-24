"use strict";

const MESSAGE_TYPES = require("../../../content/message-types.js");
const ProtocolParser = require("../../../content/protocol-parser.js");
const PlanningArtifactParser = require("../../../content/planning-artifact-parser.js");
const WorkerArtifactParser = require("../../../content/worker-artifact-parser.js");
const {
  normalizeTraceContext,
  traceDetails,
  safeProtocolValue,
  byteLength
} = require("./runtime-trace.js");

class ManagedBrowserProtocolAdapter {
  constructor({ parser = null, logger = console } = {}) {
    this.parser = parser || new ProtocolParser();
    this.logger = logger;
  }

  sender(runtime, agentId, snapshot = {}) {
    const agent = runtime.getAgent(agentId);
    return {
      agentId: agent?.agentId || String(agentId || ""),
      sessionId: runtime.sessionIdForAgent(agent),
      url: String(snapshot.url || agent?.chatUrl || "")
    };
  }

  trace(runtime, agentId, traceContext = null) {
    const agent = runtime.getAgent(agentId);
    return normalizeTraceContext(traceContext || agent?.protocolContext, {
      agentId: agent?.agentId || String(agentId || ""),
      sessionId: runtime.sessionIdForAgent(agent)
    });
  }

  async publishProtocolError(runtime, agentId, snapshot, payload = {}, traceContext = null) {
    const trace = this.trace(runtime, agentId, traceContext);
    const safePayload = {
      reason: payload?.reason || "protocol_error",
      field: payload?.field || null,
      parsedKind: payload?.parsedKind || null,
      expectedAgentId: payload?.expectedAgentId || null,
      receivedMetadata: safeProtocolValue(payload?.received),
      lastLineMetadata: safeProtocolValue(payload?.lastLine),
      responseFingerprint: snapshot?.fingerprint || "",
      trace
    };
    return runtime.publishRuntimeMessage({
      type: MESSAGE_TYPES.PROTOCOL_ERROR,
      payload: safePayload
    }, this.sender(runtime, agentId, snapshot));
  }

  async publishCompletion(runtime, agentId, snapshot = {}, traceContext = null) {
    const agent = runtime.getAgent(agentId);
    if (!agent) return { ok: false, reason: "managed_browser_completion_agent_missing" };
    const trace = this.trace(runtime, agentId, traceContext);
    const sender = this.sender(runtime, agentId, snapshot);
    const statusPayload = {
      availability: String(snapshot.availability || "unavailable"),
      generating: Boolean(snapshot.generating),
      responseFingerprint: String(snapshot.fingerprint || ""),
      fingerprint: String(snapshot.fingerprint || ""),
      messageCount: Math.max(0, Number(snapshot.messageCount) || 0),
      pathname: String(snapshot.pathname || ""),
      agentId: agent.agentId
    };

    await runtime.publishRuntimeMessage({ type: MESSAGE_TYPES.CONTENT_HEARTBEAT, payload: statusPayload }, sender);
    const completion = await runtime.publishRuntimeMessage({ type: MESSAGE_TYPES.ASSISTANT_RESPONSE_COMPLETED, payload: statusPayload }, sender);
    const parsed = this.parser.parse(snapshot.text || "");

    if (parsed.kind === "orchestra_event") {
      if (parsed.event.agentId !== agent.agentId) {
        this.logger?.warn?.("managed_browser_protocol_parse_failed", traceDetails(trace, {
          reason: "agent_mismatch_content",
          expectedAgentId: agent.agentId,
          receivedMetadata: safeProtocolValue(parsed.event.agentId),
          responseFingerprint: snapshot.fingerprint || ""
        }));
        const protocolError = await this.publishProtocolError(runtime, agent.agentId, snapshot, {
          reason: "agent_mismatch_content",
          received: parsed.event.agentId,
          expectedAgentId: agent.agentId,
          lastLine: parsed.lastLine
        }, trace);
        return { ok: false, reason: "agent_mismatch_content", completion, protocolError };
      }

      let planningArtifact = null;
      let workerArtifact = null;
      let artifactSignature = null;
      let artifactBytes = null;
      let submittedEvent = parsed.event;
      if (String(parsed.event.taskId || "").startsWith("planning:") && parsed.event.event === "DONE") {
        const artifactResult = PlanningArtifactParser.parsePlanningArtifact(snapshot.text || "");
        if (!artifactResult?.ok) {
          const reason = artifactResult?.reason || "planning_artifact_parser_unavailable";
          this.logger?.warn?.("managed_browser_protocol_parse_failed", traceDetails(trace, {
            reason,
            parsedKind: parsed.kind,
            eventId: parsed.event.eventId || null,
            responseFingerprint: snapshot.fingerprint || ""
          }));
          const protocolError = await this.publishProtocolError(runtime, agent.agentId, snapshot, {
            reason,
            lastLine: parsed.lastLine
          }, trace);
          return { ok: false, reason, completion, protocolError };
        }
        planningArtifact = artifactResult.artifact;
        artifactSignature = artifactResult.signature;
        artifactBytes = byteLength(JSON.stringify(planningArtifact));
        submittedEvent = {
          ...parsed.event,
          payload: { ...(parsed.event.payload || {}), artifactSignature: artifactResult.signature }
        };
      } else if (parsed.event.event === "DONE" && String(parsed.event.payload?.artifactFormat || "") === "file-set-v1") {
        const artifactResult = WorkerArtifactParser.parseWorkerArtifact(snapshot.text || "");
        if (!artifactResult?.ok) {
          const reason = artifactResult?.reason || "worker_artifact_parser_unavailable";
          this.logger?.warn?.("managed_browser_protocol_parse_failed", traceDetails(trace, {
            reason,
            parsedKind: parsed.kind,
            eventId: parsed.event.eventId || null,
            responseFingerprint: snapshot.fingerprint || ""
          }));
          const protocolError = await this.publishProtocolError(runtime, agent.agentId, snapshot, {
            reason,
            lastLine: parsed.lastLine
          }, trace);
          return { ok: false, reason, completion, protocolError };
        }
        workerArtifact = artifactResult.artifact;
        artifactSignature = artifactResult.signature;
        artifactBytes = artifactResult.bytes;
        submittedEvent = {
          ...parsed.event,
          payload: {
            ...(parsed.event.payload || {}),
            workerArtifactSignature: artifactResult.signature,
            workerArtifactBytes: artifactResult.bytes
          }
        };
      }

      this.logger?.info?.("managed_browser_protocol_parsed", traceDetails(trace, {
        eventId: submittedEvent.eventId || null,
        event: submittedEvent.event || null,
        projectId: submittedEvent.projectId || null,
        taskId: submittedEvent.taskId || null,
        runId: submittedEvent.runId || null,
        agentId: submittedEvent.agentId || null,
        planningArtifact: Boolean(planningArtifact),
        workerArtifact: Boolean(workerArtifact),
        artifactSignature,
        artifactBytes,
        responseFingerprint: snapshot.fingerprint || ""
      }));

      const eventResult = await runtime.publishRuntimeMessage({
        type: MESSAGE_TYPES.ORCHESTRA_EVENT,
        payload: {
          event: submittedEvent,
          responseFingerprint: snapshot.fingerprint || "",
          pathname: snapshot.pathname || "",
          messageCount: Math.max(0, Number(snapshot.messageCount) || 0),
          planningArtifact,
          workerArtifact,
          trace
        }
      }, sender);
      this.logger?.info?.("managed_browser_protocol_event_submitted", traceDetails(trace, {
        eventId: submittedEvent.eventId,
        event: submittedEvent.event,
        accepted: Boolean(eventResult?.accepted),
        applied: Boolean(eventResult?.applied),
        duplicate: Boolean(eventResult?.duplicate),
        route: eventResult?.route || null,
        reason: eventResult?.reason || null,
        cursor: eventResult?.cursor ?? null,
        planningConsumed: Boolean(eventResult?.planningConsumed),
        planningAdvanced: Boolean(eventResult?.planningAdvanced)
      }));
      if (!eventResult?.ok) {
        return {
          ok: false,
          reason: eventResult?.reason || "orchestra_event_rejected",
          completion,
          parsed,
          eventResult
        };
      }
      return { ok: true, completion, parsed, eventResult };
    }

    if (parsed.kind === "protocol_error") {
      this.logger?.warn?.("managed_browser_protocol_parse_failed", traceDetails(trace, {
        reason: parsed.reason || "protocol_parse_failed",
        field: parsed.field || null,
        receivedMetadata: safeProtocolValue(parsed.received),
        lastLineMetadata: safeProtocolValue(parsed.lastLine),
        responseFingerprint: snapshot.fingerprint || ""
      }));
      const protocolError = await this.publishProtocolError(runtime, agent.agentId, snapshot, {
        reason: parsed.reason,
        field: parsed.field,
        received: parsed.received,
        lastLine: parsed.lastLine
      }, trace);
      return { ok: false, reason: parsed.reason, completion, protocolError };
    }

    if (agent.protocolContext) {
      this.logger?.warn?.("managed_browser_protocol_parse_failed", traceDetails(trace, {
        reason: "protocol_event_missing",
        parsedKind: parsed.kind,
        lastLineMetadata: safeProtocolValue(parsed.lastLine || ""),
        responseFingerprint: snapshot.fingerprint || ""
      }));
      const protocolError = await this.publishProtocolError(runtime, agent.agentId, snapshot, {
        reason: "protocol_event_missing",
        parsedKind: parsed.kind,
        lastLine: parsed.lastLine || ""
      }, trace);
      return { ok: false, reason: "protocol_event_missing", completion, parsed, protocolError };
    }

    this.logger?.info?.("managed_browser_protocol_parsed", traceDetails(trace, {
      parsedKind: parsed.kind || "plain_response",
      orchestraEvent: false,
      responseFingerprint: snapshot.fingerprint || ""
    }));
    return { ok: true, completion, parsed };
  }
}

module.exports = { ManagedBrowserProtocolAdapter };
