(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};
  const Contracts = root.PlatformContracts || (typeof require === "function" ? require("./contracts.js") : null);
  const Control = root.RuntimeControlContract || (typeof require === "function" ? require("./runtime-control-contract.js") : null);
  const DEFAULT_CHATGPT_URL = "https://chatgpt.com/";

  function asError(error) { return error?.message || String(error || "unknown_error"); }
  function isChatGPTUrl(url) {
    try {
      const parsed = new URL(String(url || ""));
      return parsed.protocol === "https:" && (parsed.hostname === "chatgpt.com" || parsed.hostname === "chat.openai.com");
    } catch (_) {
      return false;
    }
  }

  class RuntimeAgentPool {
    constructor({
      runtime,
      workerUrl = DEFAULT_CHATGPT_URL,
      maxWorkers = 4,
      runtimeKind = "browser-runtime",
      logger = console
    } = {}) {
      this.runtime = Control.assertRuntimeControl(runtime);
      this.workerUrl = String(workerUrl || DEFAULT_CHATGPT_URL);
      this.maxWorkers = Math.max(1, Number(maxWorkers) || 4);
      this.runtimeKind = String(runtimeKind || "browser-runtime");
      this.logger = logger;
    }

    portableSender(sender = {}) {
      const requestedAgentId = sender?.agentId ? String(sender.agentId) : null;
      const agent = requestedAgentId
        ? this.runtime.getAgent?.(requestedAgentId)
        : sender?.sessionId !== null && sender?.sessionId !== undefined
          ? this.runtime.getAgentBySessionId(sender.sessionId)
          : null;
      return Contracts.normalizePortableSender({
        runtimeKind: this.runtimeKind,
        agentId: agent?.agentId || requestedAgentId || null,
        bindingPresent: Boolean(agent || sender?.sessionId !== null && sender?.sessionId !== undefined)
      });
    }

    async reconcile() {
      for (const agent of this.runtime.listAgents?.() || []) {
        const sessionId = this.runtime.sessionIdForAgent(agent);
        if (!sessionId) continue;
        try {
          const session = await this.runtime.getSession(sessionId);
          if (!session || !isChatGPTUrl(session.url)) {
            await this.runtime.updateSessionNavigation(sessionId, session?.url || "");
            continue;
          }
          await this.runtime.bindAgentToSession(agent.agentId, session, {
            chatUrl: session.url || agent.chatUrl,
            status: "CONNECTING"
          });
          await this.runtime.pingAgent(agent.agentId);
        } catch (error) {
          await this.runtime.markSessionOffline(sessionId, "session_missing_after_restart");
          this.logger.warn?.("[ChatGPT Orchestra] runtime_reconcile_failed", agent.agentId, asError(error));
        }
      }
      return { ok: true };
    }

    async registerActiveLead() {
      const session = await this.runtime.getActiveSession();
      if (!session?.id || !isChatGPTUrl(session.url)) return { ok: false, reason: "active_runtime_is_not_chatgpt" };

      const alreadyBound = this.runtime.getAgentBySessionId(session.id);
      if (alreadyBound?.role === "worker") return { ok: false, reason: "active_runtime_is_worker", agentId: alreadyBound.agentId };

      let lead = this.runtime.listAgents().find((agent) => agent.role === "lead") || null;
      const boundId = lead ? this.runtime.sessionIdForAgent(lead) : null;
      if (lead && boundId && boundId !== String(session.id)) {
        return { ok: false, reason: "lead_already_registered", agentId: lead.agentId };
      }

      lead = lead
        ? await this.runtime.bindAgentToSession(lead.agentId, session, { chatUrl: session.url, status: "CONNECTING" })
        : await this.runtime.createAgentForSession({ role: "lead", session, chatUrl: session.url, label: "Lead", status: "CONNECTING" });
      if (!lead?.agentId) return { ok: false, reason: "lead_registration_failed" };

      await this.runtime.setRuntimeStatus?.("pool_active");
      const readiness = await this.runtime.pingAgent(lead.agentId);
      return readiness?.ok
        ? { ok: true, agent: this.runtime.getAgent(lead.agentId) }
        : { ok: false, reason: readiness?.reason || "lead_not_ready", agent: this.runtime.getAgent(lead.agentId) };
    }

    async ensureWorkers(targetCount = 3) {
      const target = Math.max(1, Math.min(this.maxWorkers, Number(targetCount) || 3));
      const workers = this.runtime.listAgents().filter((agent) => agent.role === "worker");
      const live = workers.filter((agent) => this.runtime.isAgentConnected(agent));
      const offline = workers.filter((agent) => !this.runtime.isAgentConnected(agent));
      const created = [];

      for (let index = live.length; index < target; index += 1) {
        let session = null;
        let agent = null;
        try {
          session = await this.runtime.createSession({ url: "about:blank", active: false });
          const reusable = offline.shift();
          agent = reusable
            ? await this.runtime.bindAgentToSession(reusable.agentId, session, { chatUrl: this.workerUrl, status: "CONNECTING" })
            : await this.runtime.createAgentForSession({ role: "worker", session, chatUrl: this.workerUrl, label: `Worker ${index + 1}`, status: "CONNECTING" });
          if (!agent?.agentId) throw new Error("worker_agent_create_failed");
          await this.runtime.navigateSession(session.id, this.workerUrl);
          created.push(agent.agentId);
        } catch (error) {
          if (agent && session?.id) await this.runtime.markSessionOffline(session.id, "worker_session_create_failed");
          if (session?.id) {
            try { await this.runtime.removeSession(session.id); } catch (_) {}
          }
          return {
            ok: false,
            reason: "worker_runtime_create_failed",
            message: asError(error),
            created
          };
        }
      }

      await this.runtime.setRuntimeStatus?.("pool_active");
      return { ok: true, created };
    }

    async handleContentMessage(message, sender) {
      const context = sender?.sessionId !== null && sender?.sessionId !== undefined
        ? sender
        : this.runtime.normalizeSender(sender || {});
      if (!context?.sessionId) return { ok: false, reason: "missing_runtime_binding" };
      const agent = context.agentId
        ? this.runtime.getAgent(context.agentId)
        : this.runtime.getAgentBySessionId(context.sessionId);
      if (!agent) return { ok: true, ignored: true, reason: "unregistered_runtime" };

      const runtimeUrl = context.url || agent.chatUrl || "";
      if (!isChatGPTUrl(runtimeUrl)) {
        await this.runtime.updateSessionNavigation(context.sessionId, runtimeUrl);
        return { ok: false, reason: "registered_runtime_outside_chatgpt", agentId: agent.agentId };
      }

      const updated = await this.runtime.updateHeartbeat(context.sessionId, message?.payload || {}, runtimeUrl);
      return { ok: true, agent: updated, agentId: updated?.agentId || agent.agentId };
    }

    async handleBindingRemoved(sessionId, reason = "session_closed") {
      const agent = this.runtime.getAgentBySessionId(sessionId);
      if (!agent) return { ok: true, ignored: true };
      await this.runtime.markSessionOffline(sessionId, reason);
      return { ok: true, agentId: agent.agentId, role: agent.role };
    }

    async handleBindingUpdated(sessionId, changeInfo = {}, session = null) {
      const agent = this.runtime.getAgentBySessionId(sessionId);
      if (!agent) return { ok: true, ignored: true };
      const url = String(session?.url || changeInfo?.url || agent.chatUrl || "");
      if (changeInfo?.url) await this.runtime.updateSessionNavigation(sessionId, changeInfo.url);
      if (changeInfo?.status === "complete" && isChatGPTUrl(url)) await this.runtime.pingAgent(agent.agentId);
      return { ok: true, agentId: agent.agentId, agent: this.runtime.getAgent(agent.agentId) };
    }
  }

  root.RuntimeAgentPool = RuntimeAgentPool;
  root.RUNTIME_AGENT_POOL_DEFAULT_URL = DEFAULT_CHATGPT_URL;
  if (typeof module !== "undefined" && module.exports) module.exports = { RuntimeAgentPool, DEFAULT_CHATGPT_URL };
})();
