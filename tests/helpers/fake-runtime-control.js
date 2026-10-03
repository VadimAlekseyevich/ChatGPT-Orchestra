const { FakeAgentRuntime } = require("../../platform/fake-runtime.js");
const RuntimeHeartbeat = require("../../platform/runtime-heartbeat.js");

class FakeRuntimeControl extends FakeAgentRuntime {
  constructor({ agents = [], clock = () => Date.now(), readinessTtlMs = 30000 } = {}) {
    super({ clock, readinessTtlMs });
    this.sessions = new Map();
    this.agentSessions = new Map();
    this.nextSession = 1;
    for (const agent of agents) this.seedAgent(agent);
  }

  seedAgent(agent = {}) {
    const sessionId = agent.sessionId !== undefined && agent.sessionId !== null
      ? String(agent.sessionId)
      : Number.isInteger(agent.tabId)
        ? String(agent.tabId)
        : `test-session-${this.nextSession++}`;
    const session = {
      id: sessionId,
      url: String(agent.chatUrl || "https://chatgpt.com/"),
      active: agent.active !== false
    };
    this.sessions.set(session.id, session);
    const logical = super.addAgent({
      ...agent,
      bindingPresent: true
    });
    this.agentSessions.set(logical.agentId, session.id);
    return this.getAgent(logical.agentId);
  }

  rawAgent(agent) {
    if (!agent) return null;
    const sessionId = this.agentSessions.get(String(agent.agentId || "")) || null;
    const session = sessionId ? this.sessions.get(sessionId) : null;
    return {
      ...agent,
      sessionId,
      tabId: null,
      chatUrl: String(session?.url || ""),
      runtimeKind: "test-runtime-control"
    };
  }

  snapshot() {
    const base = super.snapshot();
    return {
      ...base,
      runtimeKind: "test-runtime-control",
      agents: Object.fromEntries(
        Object.values(base.agents || {}).map((agent) => [agent.agentId, this.rawAgent(agent)])
      )
    };
  }

  listAgents() { return super.listAgents().map((agent) => this.rawAgent(agent)); }
  getAgent(agentId) { return this.rawAgent(super.getAgent(agentId)); }

  getAgentBySessionId(sessionId) {
    const id = String(sessionId ?? "");
    const pair = [...this.agentSessions.entries()].find(([, value]) => value === id);
    return pair ? this.getAgent(pair[0]) : null;
  }

  sessionIdForAgent(agentOrId) {
    const agentId = typeof agentOrId === "string" ? agentOrId : agentOrId?.agentId;
    return this.agentSessions.get(String(agentId || "")) || null;
  }

  normalizeSender(sender = {}) {
    const sessionId = sender?.sessionId !== undefined && sender?.sessionId !== null
      ? String(sender.sessionId)
      : Number.isInteger(sender?.tab?.id)
        ? String(sender.tab.id)
        : null;
    const agent = sessionId ? this.getAgentBySessionId(sessionId) : sender?.agentId ? this.getAgent(sender.agentId) : null;
    return {
      kind: agent ? "agent-session" : "test-ui",
      sessionId,
      agentId: agent?.agentId || sender?.agentId || null,
      url: String(sender?.url || sender?.tab?.url || agent?.chatUrl || ""),
      legacyTabId: null
    };
  }

  async getActiveSession() {
    const session = [...this.sessions.values()].find((item) => item.active) || null;
    return session ? { ...session } : null;
  }

  async getSession(sessionId) {
    const session = this.sessions.get(String(sessionId ?? ""));
    return session ? { ...session } : null;
  }

  async createSession({ url = "about:blank", active = false } = {}) {
    if (active) for (const session of this.sessions.values()) session.active = false;
    const session = { id: `test-session-${this.nextSession++}`, url: String(url), active: Boolean(active) };
    this.sessions.set(session.id, session);
    return { ...session };
  }

  async navigateSession(sessionId, url) {
    const session = this.sessions.get(String(sessionId ?? ""));
    if (!session) throw new Error("test_session_missing");
    session.url = String(url || "");
    return { ...session };
  }

  async removeSession(sessionId) {
    const id = String(sessionId ?? "");
    const agent = this.getAgentBySessionId(id);
    const removed = this.sessions.delete(id);
    if (agent) {
      this.agentSessions.delete(agent.agentId);
      await this.disconnectAgent(agent.agentId, "runtime_unavailable");
    }
    return removed;
  }

  async bindAgentToSession(agentId, session, { status = "CONNECTING" } = {}) {
    if (!session?.id || !super.getAgent(agentId)) return null;
    this.sessions.set(String(session.id), { id: String(session.id), url: String(session.url || ""), active: Boolean(session.active) });
    this.agentSessions.set(String(agentId), String(session.id));
    await this.recoverAgent(agentId, { status });
    return this.getAgent(agentId);
  }

  async createAgentForSession({ role, session, label = "", status = "CONNECTING" } = {}) {
    if (!session?.id) return null;
    this.sessions.set(String(session.id), { id: String(session.id), url: String(session.url || ""), active: Boolean(session.active) });
    const agent = super.addAgent({ role, label, status, bindingPresent: true });
    this.agentSessions.set(agent.agentId, String(session.id));
    return this.getAgent(agent.agentId);
  }

  async markSessionOffline(sessionId, reason = "runtime_unavailable") {
    const agent = this.getAgentBySessionId(sessionId);
    if (!agent) return null;
    this.agentSessions.delete(agent.agentId);
    await this.disconnectAgent(agent.agentId, "runtime_unavailable");
    return this.getAgent(agent.agentId);
  }

  async updateSessionNavigation(sessionId, url) {
    const session = this.sessions.get(String(sessionId ?? ""));
    if (session) session.url = String(url || "");
    return this.getAgentBySessionId(sessionId);
  }

  async updateHeartbeat(sessionId, payload = {}, url = "") {
    const agent = this.getAgentBySessionId(sessionId);
    if (!agent) return null;
    if (url) await this.updateSessionNavigation(sessionId, url);
    const normalized = RuntimeHeartbeat.normalizeRuntimeHeartbeat(payload, { bindingPresent: true });
    const mutable = this.agents.get(agent.agentId);
    mutable.status = normalized.legacyStatus;
    mutable.lastSeenAt = this.clock();
    mutable.updatedAt = mutable.lastSeenAt;
    mutable.lastError = normalized.state === "UNAVAILABLE" || normalized.state === "FAILED"
      ? String(payload.reason || payload.error || normalized.reason)
      : null;
    this.transitionAgent(mutable, normalized.state, {
      reason: normalized.reason,
      legacyStatus: normalized.legacyStatus,
      readinessCheckedAt: normalized.state === "READY" ? mutable.lastSeenAt : null
    });
    return this.getAgent(agent.agentId);
  }
}

module.exports = { FakeRuntimeControl };
