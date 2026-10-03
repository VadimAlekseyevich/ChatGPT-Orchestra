"use strict";

const path = require("node:path");
const Contracts = require("../../../platform/contracts.js");
const { normalizeTraceContext, traceDetails } = require("./runtime-trace.js");

const MANAGED_BROWSER_DRIVER_METHODS = Object.freeze([
  "start",
  "close",
  "getActiveSession",
  "getSession",
  "createSession",
  "navigateSession",
  "removeSession",
  "activateSession",
  "pingSession",
  "sendPrompt",
  "stopGeneration"
]);

function clone(value) {
  if (value === undefined) return undefined;
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function urlForLog(value) {
  const raw = String(value || "");
  if (raw === "about:blank") return raw;
  try {
    const parsed = new URL(raw);
    return `${parsed.origin}${parsed.pathname}`;
  } catch (_) {
    return raw ? "[invalid-url]" : "";
  }
}

function assertManagedBrowserDriver(driver) {
  const missing = MANAGED_BROWSER_DRIVER_METHODS.filter((method) => typeof driver?.[method] !== "function");
  if (missing.length) throw new TypeError(`managed_browser_driver_contract_missing:${missing.join(",")}`);
  return driver;
}

function normalizeSession(session) {
  if (!session?.id) throw new Error("managed_browser_session_id_missing");
  return {
    id: String(session.id),
    url: String(session.url || ""),
    active: Boolean(session.active),
    title: session.title === undefined ? undefined : String(session.title || "")
  };
}

class ManagedBrowserAgentRuntime {
  constructor({
    driver,
    profileDirectory,
    clock = () => Date.now(),
    logger = console,
    maxAgents = 5,
    agentIdPrefix = "desktop-agent"
  } = {}) {
    this.driver = assertManagedBrowserDriver(driver);
    if (!profileDirectory) throw new TypeError("managed_browser_profile_directory_required");
    this.profileDirectory = path.resolve(String(profileDirectory));
    this.clock = clock;
    this.logger = logger;
    this.maxAgents = Math.max(1, Number(maxAgents) || 5);
    this.agentIdPrefix = String(agentIdPrefix || "desktop-agent");
    this.runtimeStatus = "idle";
    this.updatedAt = 0;
    this.started = false;
    this.nextAgent = 1;
    this.agents = new Map();
    this.unsubscribeDriver = null;
    this.hostHandlers = null;
  }

  async load() {
    if (!this.started) {
      const startedAt = this.clock();
      this.logger?.info?.("managed_browser_runtime_starting", { maxAgents: this.maxAgents });
      await this.driver.start({ profileDirectory: this.profileDirectory });
      this.started = true;
      if (typeof this.driver.subscribe === "function") {
        this.unsubscribeDriver = this.driver.subscribe((event) => {
          Promise.resolve(this.handleDriverEvent(event)).catch((error) => {
            this.logger?.warn?.("managed_browser_event_failed", { error: String(error?.message || error) });
          });
        });
      }
      this.logger?.info?.("managed_browser_runtime_started", {
        durationMs: Math.max(0, this.clock() - startedAt)
      });
    }
    this.updatedAt = this.clock();
    return this.snapshot();
  }

  snapshot() {
    return {
      schemaVersion: 1,
      runtimeKind: "desktop-managed-browser",
      runtimeStatus: this.runtimeStatus,
      updatedAt: this.updatedAt || this.clock(),
      agents: Object.fromEntries([...this.agents.entries()].map(([agentId, agent]) => [agentId, clone(agent)]))
    };
  }

  listAgents() { return [...this.agents.values()].map(clone); }

  getAgent(agentId) {
    const agent = this.agents.get(String(agentId || ""));
    return agent ? clone(agent) : null;
  }

  getAgentBySessionId(sessionId) {
    const id = String(sessionId ?? "");
    const agent = [...this.agents.values()].find((item) => this.sessionIdForAgent(item) === id);
    return agent ? clone(agent) : null;
  }

  getAgentByTabId(tabId) { return this.getAgentBySessionId(tabId); }

  isAgentConnected(agentOrId) {
    const agent = typeof agentOrId === "string" ? this.agents.get(agentOrId) : agentOrId;
    return Boolean(agent && this.sessionIdForAgent(agent) && agent.status !== "OFFLINE");
  }

  sessionIdForAgent(agentOrId) {
    const agent = typeof agentOrId === "string" ? this.agents.get(agentOrId) : agentOrId;
    return agent?.sessionId === null || agent?.sessionId === undefined ? null : String(agent.sessionId);
  }

  runtimeBinding(agentOrId) {
    const sessionId = this.sessionIdForAgent(agentOrId);
    return sessionId ? { kind: "desktop-browser", sessionId } : null;
  }

  normalizeSender(sender = {}) {
    const requestedAgentId = sender?.agentId ? String(sender.agentId) : null;
    const byAgent = requestedAgentId ? this.agents.get(requestedAgentId) : null;
    const bySession = sender?.sessionId !== undefined && sender?.sessionId !== null ? this.getAgentBySessionId(sender.sessionId) : null;
    const agent = byAgent || bySession;
    return Contracts.normalizeRuntimeSender({
      kind: agent ? "agent-session" : "desktop-browser-ui",
      sessionId: agent ? this.sessionIdForAgent(agent) : sender?.sessionId || null,
      agentId: agent?.agentId || requestedAgentId,
      url: agent?.chatUrl || sender?.url || ""
    });
  }

  bindHostHandlers({ onRuntimeMessage, onApiMessage, onSessionRemoved, onSessionUpdated } = {}) {
    this.hostHandlers = {
      onRuntimeMessage: typeof onRuntimeMessage === "function" ? onRuntimeMessage : null,
      onApiMessage: typeof onApiMessage === "function" ? onApiMessage : null,
      onSessionRemoved: typeof onSessionRemoved === "function" ? onSessionRemoved : null,
      onSessionUpdated: typeof onSessionUpdated === "function" ? onSessionUpdated : null
    };
    return () => this.unbindHostHandlers();
  }

  unbindHostHandlers() { this.hostHandlers = null; }

  async publishRuntimeMessage(message, sender = {}) {
    const handler = this.hostHandlers?.onRuntimeMessage;
    if (!handler) return { ok: false, reason: "managed_browser_host_unbound" };
    return handler(message, this.normalizeSender(sender));
  }

  async publishApiMessage(message, sender = {}) {
    const handler = this.hostHandlers?.onApiMessage;
    if (!handler) return { ok: false, reason: "managed_browser_host_unbound" };
    return handler(message, this.normalizeSender(sender));
  }

  async setRuntimeStatus(status) {
    this.runtimeStatus = String(status || "idle");
    this.updatedAt = this.clock();
    return this.snapshot();
  }

  async setProtocolContext(agentId, context) {
    const agent = this.agents.get(String(agentId || ""));
    if (!agent) return null;
    agent.protocolContext = context ? clone(context) : null;
    agent.updatedAt = this.clock();
    this.updatedAt = agent.updatedAt;
    return this.getAgent(agent.agentId);
  }

  async clearProtocolContext(agentId) { return this.setProtocolContext(agentId, null); }

  async removeAgent(agentId) {
    const id = String(agentId || "");
    if (!this.agents.has(id)) return false;
    this.agents.delete(id);
    this.updatedAt = this.clock();
    return true;
  }

  async getActiveSession() {
    await this.ensureStarted();
    const session = await this.driver.getActiveSession();
    return session ? normalizeSession(session) : null;
  }

  async getSession(sessionId) {
    await this.ensureStarted();
    const session = await this.driver.getSession(String(sessionId ?? ""));
    return session ? normalizeSession(session) : null;
  }

  async createSession({ url = "about:blank", active = false } = {}) {
    await this.ensureStarted();
    const startedAt = this.clock();
    const targetUrl = String(url || "about:blank");
    this.logger?.info?.("managed_browser_session_create_started", {
      active: Boolean(active),
      url: urlForLog(targetUrl)
    });
    try {
      const session = normalizeSession(await this.driver.createSession({ url: targetUrl, active: Boolean(active) }));
      this.logger?.info?.("managed_browser_session_created", {
        sessionId: session.id,
        active: session.active,
        url: urlForLog(session.url),
        durationMs: Math.max(0, this.clock() - startedAt)
      });
      return session;
    } catch (error) {
      this.logger?.error?.("managed_browser_session_create_failed", {
        active: Boolean(active),
        url: urlForLog(targetUrl),
        durationMs: Math.max(0, this.clock() - startedAt),
        error
      });
      throw error;
    }
  }

  async navigateSession(sessionId, url) {
    await this.ensureStarted();
    const id = String(sessionId ?? "");
    const targetUrl = String(url || "");
    const startedAt = this.clock();
    this.logger?.info?.("managed_browser_session_navigation_started", {
      sessionId: id,
      url: urlForLog(targetUrl)
    });
    try {
      const session = normalizeSession(await this.driver.navigateSession(id, targetUrl));
      await this.updateSessionNavigation(session.id, session.url);
      this.logger?.info?.("managed_browser_session_navigation_completed", {
        sessionId: session.id,
        url: urlForLog(session.url),
        durationMs: Math.max(0, this.clock() - startedAt)
      });
      return session;
    } catch (error) {
      this.logger?.error?.("managed_browser_session_navigation_failed", {
        sessionId: id,
        url: urlForLog(targetUrl),
        durationMs: Math.max(0, this.clock() - startedAt),
        error
      });
      throw error;
    }
  }

  async removeSession(sessionId) {
    await this.ensureStarted();
    const id = String(sessionId ?? "");
    const agent = this.getAgentBySessionId(id);
    const result = await this.driver.removeSession(id);
    if (agent && !this.hostHandlers?.onSessionRemoved) await this.markSessionOffline(id, "session_removed");
    this.logger?.info?.("managed_browser_session_removed", {
      sessionId: id,
      agentId: agent?.agentId || null,
      removed: Boolean(result)
    });
    return result;
  }

  async activateAgent(agentId) {
    const agent = this.getAgent(agentId);
    const sessionId = this.sessionIdForAgent(agent);
    if (!sessionId) return { ok: false, reason: "agent_offline", agentId: String(agentId || "") };
    await this.ensureStarted();
    const session = normalizeSession(await this.driver.activateSession(sessionId));
    await this.updateSessionNavigation(sessionId, session.url);
    return { ok: true, agentId: agent.agentId, session };
  }

  async bindAgentToSession(agentId, session, { status = "CONNECTING", chatUrl = "" } = {}) {
    const agent = this.agents.get(String(agentId || ""));
    if (!agent || !session?.id) return null;
    const normalized = normalizeSession(session);
    agent.sessionId = normalized.id;
    agent.tabId = null;
    agent.chatUrl = String(chatUrl || normalized.url || agent.chatUrl || "");
    agent.status = String(status || "CONNECTING");
    agent.lastError = null;
    agent.updatedAt = this.clock();
    this.updatedAt = agent.updatedAt;
    return this.getAgent(agent.agentId);
  }

  async createAgentForSession({ role, session, chatUrl = "", label = "", status = "CONNECTING" } = {}) {
    if (!session?.id) return null;
    if (this.agents.size >= this.maxAgents) return null;
    const normalized = normalizeSession(session);
    let agentId;
    do { agentId = `${this.agentIdPrefix}-${this.nextAgent++}`; } while (this.agents.has(agentId));
    const now = this.clock();
    const agent = {
      agentId,
      role: role === "lead" ? "lead" : "worker",
      label: String(label || ""),
      status: String(status || "CONNECTING"),
      protocolContext: null,
      lastSeenAt: now,
      updatedAt: now,
      sessionId: normalized.id,
      tabId: null,
      chatUrl: String(chatUrl || normalized.url || ""),
      runtimeKind: "desktop-browser"
    };
    this.agents.set(agentId, agent);
    this.updatedAt = now;
    this.logger?.info?.("managed_browser_agent_created", {
      agentId,
      role: agent.role,
      sessionId: normalized.id,
      status: agent.status,
      url: urlForLog(agent.chatUrl)
    });
    return this.getAgent(agentId);
  }

  async replaceAgentSession(agentId, { url = "https://chatgpt.com/", active = false } = {}) {
    const agent = this.getAgent(agentId);
    if (!agent) return { ok: false, reason: "unknown_agent", agentId: String(agentId || "") };
    const oldSessionId = this.sessionIdForAgent(agent);
    const session = await this.createSession({ url, active });
    await this.bindAgentToSession(agent.agentId, session, { status: "CONNECTING", chatUrl: session.url });
    if (oldSessionId && oldSessionId !== session.id) {
      try { await this.driver.removeSession(oldSessionId); } catch (error) {
        this.logger?.warn?.("managed_browser_old_session_cleanup_failed", { agentId: agent.agentId, error: String(error?.message || error) });
      }
    }
    return { ok: true, agent: this.getAgent(agent.agentId), session };
  }

  async markSessionOffline(sessionId, reason = "session_unavailable") {
    const agent = this.getAgentBySessionId(sessionId);
    if (!agent) return null;
    const mutable = this.agents.get(agent.agentId);
    mutable.status = "OFFLINE";
    mutable.lastError = String(reason || "session_unavailable");
    mutable.sessionId = null;
    mutable.tabId = null;
    mutable.updatedAt = this.clock();
    this.updatedAt = mutable.updatedAt;
    this.logger?.warn?.("managed_browser_agent_offline", {
      agentId: mutable.agentId,
      reason: mutable.lastError
    });
    return this.getAgent(agent.agentId);
  }

  async updateSessionNavigation(sessionId, url) {
    const agent = this.getAgentBySessionId(sessionId);
    if (!agent) return null;
    const mutable = this.agents.get(agent.agentId);
    mutable.chatUrl = String(url || mutable.chatUrl || "");
    mutable.updatedAt = this.clock();
    this.updatedAt = mutable.updatedAt;
    return this.getAgent(agent.agentId);
  }

  async updateHeartbeat(sessionId, payload = {}, url = "") {
    const agent = this.getAgentBySessionId(sessionId);
    if (!agent) return null;
    const mutable = this.agents.get(agent.agentId);
    const availability = String(payload.availability || "unknown");
    if (payload.generating === true || availability === "generating") mutable.status = "BUSY";
    else if (availability === "ready") mutable.status = "IDLE";
    else if (availability === "error" || availability === "unavailable") mutable.status = "ERROR";
    else if (mutable.status !== "OFFLINE") mutable.status = "CONNECTING";
    mutable.lastSeenAt = this.clock();
    mutable.updatedAt = mutable.lastSeenAt;
    mutable.lastError = mutable.status === "ERROR"
      ? String(payload.reason || payload.error || availability || "chat_unavailable")
      : null;
    mutable.chatState = {
      generating: Boolean(payload.generating),
      availability,
      composerOccupied: payload.composerOccupied === null || payload.composerOccupied === undefined
        ? null
        : Boolean(payload.composerOccupied),
      pathname: String(payload.pathname || "")
    };
    if (url) mutable.chatUrl = String(url);
    this.updatedAt = mutable.updatedAt;
    this.logger?.debug?.("managed_browser_agent_heartbeat", {
      agentId: mutable.agentId,
      status: mutable.status,
      availability,
      generating: payload.generating === true,
      composerOccupied: mutable.chatState.composerOccupied
    });
    return this.getAgent(agent.agentId);
  }

  async pingAgent(agentId) {
    const agent = this.getAgent(agentId);
    const sessionId = this.sessionIdForAgent(agent);
    if (!sessionId) return { ok: false, reason: "agent_offline", agentId: String(agentId || "") };
    await this.ensureStarted();
    const startedAt = this.clock();

    const markUnready = (reason) => {
      const mutable = this.agents.get(agent.agentId);
      if (!mutable) return null;
      const now = this.clock();
      mutable.status = "ERROR";
      mutable.lastError = String(reason || "agent_unreachable");
      mutable.updatedAt = now;
      mutable.chatState = {
        generating: false,
        availability: "unavailable",
        composerOccupied: null,
        pathname: ""
      };
      this.updatedAt = now;
      return this.getAgent(agent.agentId);
    };

    try {
      const result = await this.driver.pingSession(sessionId);
      if (!result?.ok) {
        const updated = markUnready(result?.reason || "agent_unreachable");
        this.logger?.warn?.("managed_browser_agent_ping_failed", {
          agentId: agent.agentId,
          sessionId,
          reason: result?.reason || "ping_failed",
          durationMs: Math.max(0, this.clock() - startedAt)
        });
        return { ...(result || {}), ok: false, agent: updated, agentId: agent.agentId };
      }
      const updated = await this.updateHeartbeat(sessionId, result, result.url || agent.chatUrl || "");
      this.logger?.debug?.("managed_browser_agent_ping_completed", {
        agentId: agent.agentId,
        sessionId,
        availability: result.availability || null,
        generating: result.generating === true,
        durationMs: Math.max(0, this.clock() - startedAt)
      });
      return { ...result, ok: true, agent: updated || this.getAgent(agent.agentId), agentId: agent.agentId };
    } catch (error) {
      const updated = markUnready("agent_unreachable");
      this.logger?.error?.("managed_browser_agent_ping_error", {
        agentId: agent.agentId,
        sessionId,
        durationMs: Math.max(0, this.clock() - startedAt),
        error
      });
      return { ok: false, reason: "agent_unreachable", message: String(error?.message || error), agent: updated, agentId: agent.agentId };
    }
  }

  async sendPrompt(agentId, prompt, options = {}) {
    const agent = this.getAgent(agentId);
    const sessionId = this.sessionIdForAgent(agent);
    if (!sessionId) return { ok: false, reason: "agent_offline", agentId: String(agentId || "") };
    await this.ensureStarted();
    const startedAt = this.clock();
    const promptBytes = Buffer.byteLength(String(prompt || ""), "utf8");
    const trace = normalizeTraceContext(options?.trace || agent?.protocolContext, {
      agentId: agent.agentId,
      sessionId
    });
    this.logger?.info?.("managed_browser_prompt_send_started", traceDetails(trace, {
      promptBytes
    }));
    try {
      const result = await this.driver.sendPrompt(sessionId, String(prompt || ""), { trace });
      if (result?.ok) await this.updateHeartbeat(sessionId, { availability: "generating", generating: true }, result.url || agent.chatUrl || "");
      const completionDetails = traceDetails(trace, {
        promptBytes,
        ok: result?.ok !== false,
        promptAccepted: result?.accepted === true || result?.ok === true,
        promptConfirmed: result?.confirmed === true,
        confirmationMethod: result?.method || null,
        navigationReconciliation: ["navigation", "navigation-reconciled"].includes(String(result?.method || "")),
        preloadTimeoutRecovery: result?.recoveredFrom === "agent_preload_timeout",
        recoveredFrom: result?.recoveredFrom || null,
        reason: result?.reason || null,
        durationMs: Math.max(0, this.clock() - startedAt)
      });
      if (result?.ok === false) this.logger?.warn?.("managed_browser_prompt_send_failed", completionDetails);
      else this.logger?.info?.("managed_browser_prompt_send_completed", completionDetails);
      return { ...(result || {}), agentId: agent.agentId, trace };
    } catch (error) {
      this.logger?.error?.("managed_browser_prompt_send_failed", traceDetails(trace, {
        promptBytes,
        promptAccepted: false,
        promptConfirmed: false,
        durationMs: Math.max(0, this.clock() - startedAt),
        reason: "agent_unreachable",
        error
      }));
      return {
        ok: false,
        reason: "agent_unreachable",
        message: String(error?.message || error),
        agentId: agent.agentId,
        trace
      };
    }
  }

  async stopAgent(agentId) {
    const agent = this.getAgent(agentId);
    const sessionId = this.sessionIdForAgent(agent);
    if (!sessionId) return { ok: false, reason: "agent_offline", agentId: String(agentId || "") };
    await this.ensureStarted();
    const startedAt = this.clock();
    this.logger?.info?.("managed_browser_stop_started", { agentId: agent.agentId, sessionId });
    try {
      const result = await this.driver.stopGeneration(sessionId);
      if (result?.ok) await this.updateHeartbeat(sessionId, { availability: "ready", generating: false }, result.url || agent.chatUrl || "");
      this.logger?.info?.("managed_browser_stop_completed", {
        agentId: agent.agentId,
        sessionId,
        ok: result?.ok !== false,
        reason: result?.reason || null,
        durationMs: Math.max(0, this.clock() - startedAt)
      });
      return { ...(result || {}), agentId: agent.agentId };
    } catch (error) {
      this.logger?.error?.("managed_browser_stop_failed", {
        agentId: agent.agentId,
        sessionId,
        durationMs: Math.max(0, this.clock() - startedAt),
        error
      });
      return { ok: false, reason: "agent_unreachable", message: String(error?.message || error), agentId: agent.agentId };
    }
  }

  async handleDriverEvent(event = {}) {
    const type = String(event.type || "");
    this.logger?.debug?.("managed_browser_driver_event", {
      type,
      sessionId: event.sessionId === undefined || event.sessionId === null ? null : String(event.sessionId),
      agentId: event.agentId || null,
      reason: event.reason || null
    });
    if (type === "runtime-message") return this.publishRuntimeMessage(event.message || {}, { sessionId: event.sessionId, agentId: event.agentId, url: event.url || "" });
    if (type === "api-message") return this.publishApiMessage(event.message || {}, { sessionId: event.sessionId, agentId: event.agentId, url: event.url || "" });
    if (type === "session-removed") {
      if (this.hostHandlers?.onSessionRemoved) return this.hostHandlers.onSessionRemoved(String(event.sessionId ?? ""));
      return this.markSessionOffline(event.sessionId, event.reason || "session_removed");
    }
    if (type === "session-navigation") {
      const sessionId = String(event.sessionId ?? "");
      if (this.hostHandlers?.onSessionUpdated) {
        let session = null;
        try { session = await this.driver.getSession(sessionId); } catch (_) { session = null; }
        return this.hostHandlers.onSessionUpdated(sessionId, { url: String(event.url || "") }, session);
      }
      return this.updateSessionNavigation(sessionId, event.url || "");
    }
    if (type === "heartbeat") return this.updateHeartbeat(event.sessionId, event.payload || {}, event.url || "");
    if (type === "browser-crashed") {
      const bindings = [...this.agents.values()].map((agent) => ({ agentId: agent.agentId, sessionId: this.sessionIdForAgent(agent) })).filter((item) => item.sessionId);
      if (this.hostHandlers?.onSessionRemoved) {
        for (const binding of bindings) await this.hostHandlers.onSessionRemoved(binding.sessionId);
      } else {
        for (const binding of bindings) await this.markSessionOffline(binding.sessionId, event.reason || "browser_crashed");
      }
      this.runtimeStatus = "offline";
      this.updatedAt = this.clock();
      return this.snapshot();
    }
    return null;
  }

  async ensureStarted() {
    if (!this.started) await this.load();
  }

  async close() {
    const startedAt = this.clock();
    this.logger?.info?.("managed_browser_runtime_closing", {
      agents: this.agents.size,
      started: this.started
    });
    try { this.unsubscribeDriver?.(); } catch (error) {
      this.logger?.warn?.("managed_browser_unsubscribe_failed", { error });
    }
    this.unsubscribeDriver = null;
    this.unbindHostHandlers();
    if (this.started) await this.driver.close();
    this.started = false;
    this.logger?.info?.("managed_browser_runtime_closed", {
      durationMs: Math.max(0, this.clock() - startedAt)
    });
  }
}

module.exports = {
  ManagedBrowserAgentRuntime,
  MANAGED_BROWSER_DRIVER_METHODS,
  assertManagedBrowserDriver
};
