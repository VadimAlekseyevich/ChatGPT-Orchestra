"use strict";

const { ManagedBrowserAgentRuntime } = require("./managed-browser-agent-runtime.js");
const { normalizeTraceContext, traceDetails, traceDurationMs } = require("./runtime-trace.js");

class CompletionAwareManagedBrowserRuntime extends ManagedBrowserAgentRuntime {
  constructor({ completionMonitor, ...options } = {}) {
    if (!completionMonitor || typeof completionMonitor.prepare !== "function" || typeof completionMonitor.start !== "function") {
      throw new TypeError("managed_browser_completion_monitor_required");
    }
    super(options);
    this.completionMonitor = completionMonitor;
  }

  async sendPrompt(agentId, prompt, options = {}) {
    const agent = this.getAgent(agentId);
    const trace = normalizeTraceContext(options?.trace || agent?.protocolContext, {
      agentId: agent?.agentId || String(agentId || ""),
      sessionId: this.sessionIdForAgent(agent)
    });
    const prepared = await this.completionMonitor.prepare(this, agentId, trace);
    if (!prepared?.ok) {
      this.logger?.error?.("runtime_trace_failed", traceDetails(trace, {
        totalDurationMs: traceDurationMs(trace, this.clock()),
        lastSuccessfulStage: "planning_dispatch",
        reason: prepared?.reason || "completion_monitor_prepare_failed",
        protocolAccepted: false,
        protocolApplied: false,
        planningAdvanced: false
      }));
      return {
        ok: false,
        reason: "completion_monitor_prepare_failed",
        details: { reason: prepared?.reason || "unknown" },
        agentId: String(agentId || ""),
        trace
      };
    }

    const result = await super.sendPrompt(agentId, prompt, { ...options, trace });
    if (!result?.ok) {
      this.logger?.error?.("runtime_trace_failed", traceDetails(trace, {
        totalDurationMs: traceDurationMs(trace, this.clock()),
        lastSuccessfulStage: "completion_prepare",
        reason: result?.reason || "prompt_send_failed",
        promptAccepted: result?.accepted === true,
        protocolAccepted: false,
        protocolApplied: false,
        planningAdvanced: false
      }));
      return result;
    }
    const started = this.completionMonitor.start(this, agentId, prepared);
    if (!started?.ok) {
      try { await super.stopAgent(agentId); } catch (_) {}
      this.logger?.error?.("runtime_trace_failed", traceDetails(trace, {
        totalDurationMs: traceDurationMs(trace, this.clock()),
        lastSuccessfulStage: "prompt_send",
        reason: started?.reason || "completion_monitor_start_failed",
        promptAccepted: true,
        protocolAccepted: false,
        protocolApplied: false,
        planningAdvanced: false
      }));
      return {
        ok: false,
        reason: "completion_monitor_start_failed",
        details: { reason: started?.reason || "unknown" },
        agentId: String(agentId || ""),
        promptAccepted: true,
        trace
      };
    }
    return { ...result, trace, completionMonitor: { active: true, token: started.token } };
  }

  async stopAgent(agentId) {
    this.completionMonitor.cancel(agentId, "generation_stopped");
    return super.stopAgent(agentId);
  }

  async replaceAgentSession(agentId, options = {}) {
    this.completionMonitor.cancel(agentId, "agent_session_replaced");
    return super.replaceAgentSession(agentId, options);
  }

  async markSessionOffline(sessionId, reason = "session_unavailable") {
    this.completionMonitor.cancelSession(sessionId, reason);
    return super.markSessionOffline(sessionId, reason);
  }

  async removeAgent(agentId) {
    this.completionMonitor.cancel(agentId, "agent_removed");
    return super.removeAgent(agentId);
  }

  async close() {
    this.completionMonitor.close();
    return super.close();
  }
}

module.exports = { CompletionAwareManagedBrowserRuntime };
