"use strict";

const MESSAGE_TYPES = require("../../../content/message-types.js");
const ProtocolParser = require("../../../content/protocol-parser.js");
const PlanningArtifactParser = require("../../../content/planning-artifact-parser.js");
const WorkerArtifactParser = require("../../../content/worker-artifact-parser.js");

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

  async publishProtocolError(runtime, agentId, snapshot, payload) {
    return runtime.publishRuntimeMessage({
      type: MESSAGE_TYPES.PROTOCOL_ERROR,
      payload: {
        ...payload,
        responseFingerprint: snapshot?.fingerprint || ""
      }
    }, this.sender(runtime, agentId, snapshot));
  }

  async publishCompletion(runtime, agentId, snapshot = {}) {
    const agent = runtime.getAgent(agentId);
    if (!agent) return { ok: false, reason: "managed_browser_completion_agent_missing" };
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
        const protocolError = await this.publishProtocolError(runtime, agent.agentId, snapshot, {
          reason: "agent_mismatch_content",
          received: parsed.event.agentId,
          expectedAgentId: agent.agentId,
          lastLine: parsed.lastLine
        });
        return { ok: false, reason: "agent_mismatch_content", completion, protocolError };
      }

      let planningArtifact = null;
      let workerArtifact = null;
      let submittedEvent = parsed.event;
      if (String(parsed.event.taskId || "").startsWith("planning:") && parsed.event.event === "DONE") {
        const artifactResult = PlanningArtifactParser.parsePlanningArtifact(snapshot.text || "");
        if (!artifactResult?.ok) {
          const protocolError = await this.publishProtocolError(runtime, agent.agentId, snapshot, {
            reason: artifactResult?.reason || "planning_artifact_parser_unavailable",
            lastLine: parsed.lastLine
          });
          return { ok: false, reason: artifactResult?.reason || "planning_artifact_parser_unavailable", completion, protocolError };
        }
        planningArtifact = artifactResult.artifact;
        submittedEvent = {
          ...parsed.event,
          payload: { ...(parsed.event.payload || {}), artifactSignature: artifactResult.signature }
        };
      } else if (parsed.event.event === "DONE" && String(parsed.event.payload?.artifactFormat || "") === "file-set-v1") {
        const artifactResult = WorkerArtifactParser.parseWorkerArtifact(snapshot.text || "");
        if (!artifactResult?.ok) {
          const protocolError = await this.publishProtocolError(runtime, agent.agentId, snapshot, {
            reason: artifactResult?.reason || "worker_artifact_parser_unavailable",
            lastLine: parsed.lastLine
          });
          return { ok: false, reason: artifactResult?.reason || "worker_artifact_parser_unavailable", completion, protocolError };
        }
        workerArtifact = artifactResult.artifact;
        submittedEvent = {
          ...parsed.event,
          payload: {
            ...(parsed.event.payload || {}),
            workerArtifactSignature: artifactResult.signature,
            workerArtifactBytes: artifactResult.bytes
          }
        };
      }

      const eventResult = await runtime.publishRuntimeMessage({
        type: MESSAGE_TYPES.ORCHESTRA_EVENT,
        payload: {
          event: submittedEvent,
          responseFingerprint: snapshot.fingerprint || "",
          pathname: snapshot.pathname || "",
          messageCount: Math.max(0, Number(snapshot.messageCount) || 0),
          planningArtifact,
          workerArtifact
        }
      }, sender);
      this.logger?.info?.("managed_browser_protocol_event_submitted", {
        eventId: submittedEvent.eventId,
        event: submittedEvent.event,
        accepted: Boolean(eventResult?.accepted),
        duplicate: Boolean(eventResult?.duplicate),
        reason: eventResult?.reason || null
      });
      return { ok: true, completion, parsed, eventResult };
    }

    if (parsed.kind === "protocol_error") {
      const protocolError = await this.publishProtocolError(runtime, agent.agentId, snapshot, {
        reason: parsed.reason,
        field: parsed.field,
        received: parsed.received,
        lastLine: parsed.lastLine
      });
      return { ok: false, reason: parsed.reason, completion, protocolError };
    }

    return { ok: true, completion, parsed };
  }
}

module.exports = { ManagedBrowserProtocolAdapter };
