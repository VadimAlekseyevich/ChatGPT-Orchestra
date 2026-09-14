"use strict";

const { ManagedBrowserAgentRuntime } = require("./managed-browser-agent-runtime.js");

class CompletionAwareManagedBrowserRuntime extends ManagedBrowserAgentRuntime {
  constructor({ completionMonitor, ...options } = {}) {
    if (!completionMonitor || typeof completionMonitor.prepare !== "function" || typeof completionMonitor.start !== "function") {
      throw new TypeError("managed_browser_completion_monitor_required");
    }
    super(options);
    this.completionMonitor = completionMonitor;
  }

  async sendPrompt(agentId, prompt) {
    const prepared = await this.completionMonitor.prepare(this, agentId);
    if (!prepared?.ok) {
      return {
        ok: false,
        reason: "completion_monitor_prepare_failed",
        details: { reason: prepared?.reason || "unknown" },
        agentId: String(agentId || "")
      };
    }

    const result = await super.sendPrompt(agentId, prompt);
    if (!result?.ok) return result;
    const started = this.completionMonitor.start(this, agentId, prepared);
    if (!started?.ok) {
      try { await super.stopAgent(agentId); } catch (_) {}
      return {
        ok: false,
        reason: "completion_monitor_start_failed",
        details: { reason: started?.reason || "unknown" },
        agentId: String(agentId || ""),
        promptAccepted: true
      };
    }
    return { ...result, completionMonitor: { active: true, token: started.token } };
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
