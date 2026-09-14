"use strict";

const path = require("node:path");
const Contracts = require("../../../platform/contracts.js");

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
      await this.driver.start({ profileDirectory: this.profileDirectory });
      this.started = true;
      if (typeof this.driver.subscribe === "function") {
        this.unsubscribeDriver = this.driver.subscribe((event) => {
          Promise.resolve(this.handleDriverEvent(event)).catch((error) => {
            this.logger?.warn?.("managed_browser_event_failed", { error: String(error?.message || error) });
          });
        });
      }
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
    return normalizeSession(await this.driver.createSession({ url: String(url || "about:blank"), active: Boolean(active) }));
  }

  async navigateSession(sessionId, url) {
    await this.ensureStarted();
    const session = normalizeSession(await this.driver.navigateSession(String(sessionId ?? ""), String(url || "")));
    await this.updateSessionNavigation(session.id, session.url);
    return session;
  }

  async removeSession(sessionId) {
    await this.ensureStarted();
    const id = String(sessionId ?? "");
    const agent = this.getAgentBySessionId(id);
    const result = await this.driver.removeSession(id);
    if (agent && !this.hostHandlers?.onSessionRemoved) await this.markSessionOffline(id, "session_removed");
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
    if (payload.generating === true || payload.availability === "generating") mutable.status = "BUSY";
    else if (payload.availability === "ready" || payload.generating === false) mutable.status = "IDLE";
    mutable.lastSeenAt = this.clock();
    mutable.updatedAt = mutable.lastSeenAt;
    mutable.lastError = null;
    if (url) mutable.chatUrl = String(url);
    this.updatedAt = mutable.updatedAt;
    return this.getAgent(agent.agentId);
  }

  async pingAgent(agentId) {
    const agent = this.getAgent(agentId);
    const sessionId = this.sessionIdForAgent(agent);
    if (!sessionId) return { ok: false, reason: "agent_offline", agentId: String(agentId || "") };
    await this.ensureStarted();
    try {
      const result = await this.driver.pingSession(sessionId);
      if (!result?.ok) return { ...result, agentId: agent.agentId };
      const updated = await this.updateHeartbeat(sessionId, result, result.url || agent.chatUrl || "");
      return { ...result, ok: true, agent: updated || this.getAgent(agent.agentId), agentId: agent.agentId };
    } catch (error) {
      return { ok: false, reason: "agent_unreachable", message: String(error?.message || error), agentId: agent.agentId };
    }
  }

  async sendPrompt(agentId, prompt) {
    const agent = this.getAgent(agentId);
    const sessionId = this.sessionIdForAgent(agent);
    if (!sessionId) return { ok: false, reason: "agent_offline", agentId: String(agentId || "") };
    await this.ensureStarted();
    try {
      const result = await this.driver.sendPrompt(sessionId, String(prompt || ""));
      if (result?.ok) await this.updateHeartbeat(sessionId, { availability: "generating", generating: true }, result.url || agent.chatUrl || "");
      return { ...(result || {}), agentId: agent.agentId };
    } catch (error) {
      return { ok: false, reason: "agent_unreachable", message: String(error?.message || error), agentId: agent.agentId };
    }
  }

  async stopAgent(agentId) {
    const agent = this.getAgent(agentId);
    const sessionId = this.sessionIdForAgent(agent);
    if (!sessionId) return { ok: false, reason: "agent_offline", agentId: String(agentId || "") };
    await this.ensureStarted();
    try {
      const result = await this.driver.stopGeneration(sessionId);
      if (result?.ok) await this.updateHeartbeat(sessionId, { availability: "ready", generating: false }, result.url || agent.chatUrl || "");
      return { ...(result || {}), agentId: agent.agentId };
    } catch (error) {
      return { ok: false, reason: "agent_unreachable", message: String(error?.message || error), agentId: agent.agentId };
    }
  }

  async handleDriverEvent(event = {}) {
    const type = String(event.type || "");
    if (type === "runtime-message") return this.publishRuntimeMessage(event.message || {}, { sessionId: event.sessionId, agentId: event.agentId, url: event.url || "" });
    if (type === "api-message") return this.publishApiMessage(event.message || {}, { sessionId: event.sessionId, agentId: event.agentId, url: event.url || "" });
    if (type === "session-removed") {
      if (this.hostHandlers?.onSessionRemoved) return this.hostHandlers.onSessionRemoved(String(event.sessionId ?? ""));
      return this.markSessionOffline(event.sessionId, event.reason || "session_removed");
    }
    if (type === "session-navigation") {
      const sessionId = String(event.sessionId ?? "");
      if (this.hostHandlers?.onSessionUpdated) {
        const session = await this.driver.getSession(sessionId).catch?.(() => null) || null;
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
    try { this.unsubscribeDriver?.(); } catch (_) {}
    this.unsubscribeDriver = null;
    this.unbindHostHandlers();
    if (this.started) await this.driver.close();
    this.started = false;
  }
}

module.exports = {
  ManagedBrowserAgentRuntime,
  MANAGED_BROWSER_DRIVER_METHODS,
  assertManagedBrowserDriver
};
