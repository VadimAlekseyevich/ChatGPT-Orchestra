(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};
  const Contracts = root.PlatformContracts || (typeof require === "function" ? require("./contracts.js") : null);
  const CHATGPT_HOME = "https://chatgpt.com/";

  function asError(error) { return error?.message || String(error || "unknown_error"); }

  class ChromeStorageStateStore {
    constructor({ storageArea = globalThis.chrome?.storage?.local } = {}) {
      this.storageArea = storageArea || null;
    }
    async get(key) {
      if (!this.storageArea?.get) return typeof key === "string" ? { [key]: undefined } : {};
      return this.storageArea.get(key);
    }
    async set(values) {
      if (!this.storageArea?.set) return;
      return this.storageArea.set(values || {});
    }
    async remove(keys) {
      if (!this.storageArea?.remove) return;
      return this.storageArea.remove(keys);
    }
    async clear() {
      if (!this.storageArea?.clear) return;
      return this.storageArea.clear();
    }
  }

  class ExtensionAgentRuntime {
    constructor({ chromeApi = globalThis.chrome, registry, messageTypes = null, workerUrl = CHATGPT_HOME, logger = console } = {}) {
      this.chrome = chromeApi;
      this.registry = registry;
      this.messageTypes = messageTypes || root.MESSAGE_TYPES || {};
      this.workerUrl = workerUrl;
      this.logger = logger;
    }

    async load() { return this.registry?.load?.(); }
    snapshot() { return this.registry?.snapshot?.() || { agents: {} }; }
    listAgents() { return this.registry?.listAgents?.() || []; }
    getAgent(agentId) { return this.registry?.getAgent?.(agentId) || null; }
    getAgentBySessionId(sessionId) {
      const numeric = Number(sessionId);
      return Number.isInteger(numeric) ? this.registry?.getAgentByTabId?.(numeric) || null : null;
    }
    getAgentByTabId(tabId) { return this.getAgentBySessionId(tabId); }
    async setRuntimeStatus(status) { return this.registry?.setRuntimeStatus?.(status); }
    async setProtocolContext(agentId, context) { return this.registry?.setProtocolContext?.(agentId, context); }
    async clearProtocolContext(agentId) { return this.registry?.clearProtocolContext?.(agentId); }
    async removeAgent(agentId) { return this.registry?.removeAgent?.(agentId); }

    sessionIdForAgent(agentOrId) {
      const agent = typeof agentOrId === "string" ? this.getAgent(agentOrId) : agentOrId;
      return Number.isInteger(agent?.tabId) ? String(agent.tabId) : null;
    }

    runtimeBinding(agentOrId) {
      const sessionId = this.sessionIdForAgent(agentOrId);
      return sessionId ? { kind: "extension-tab", sessionId } : null;
    }

    isAgentConnected(agentOrId) {
      const agent = typeof agentOrId === "string" ? this.getAgent(agentOrId) : agentOrId;
      return Boolean(agent && this.sessionIdForAgent(agent) && !["OFFLINE", "ERROR"].includes(agent.status));
    }

    normalizeSender(sender = {}) {
      const tabId = sender?.tab?.id;
      if (!Number.isInteger(tabId)) return Contracts.normalizeRuntimeSender({ kind: "extension-ui" });
      const agent = this.registry?.getAgentByTabId?.(tabId) || null;
      return Contracts.normalizeRuntimeSender({
        kind: agent ? "agent-session" : "unregistered-session",
        sessionId: String(tabId),
        agentId: agent?.agentId || null,
        url: sender?.tab?.url || agent?.chatUrl || "",
        legacyTabId: tabId
      });
    }

    async getActiveSession() {
      const tabs = await this.chrome?.tabs?.query?.({ active: true, currentWindow: true });
      const tab = tabs?.[0];
      return tab && Number.isInteger(tab.id) ? { id: String(tab.id), url: String(tab.url || ""), active: true } : null;
    }

    async getSession(sessionId) {
      const id = Number(sessionId);
      if (!Number.isInteger(id)) throw new Error("invalid_extension_session_id");
      const tab = await this.chrome?.tabs?.get?.(id);
      return tab ? { id: String(tab.id), url: String(tab.url || ""), active: Boolean(tab.active) } : null;
    }

    async createSession({ url = "about:blank", active = false } = {}) {
      const tab = await this.chrome?.tabs?.create?.({ url, active });
      if (!tab || !Number.isInteger(tab.id)) throw new Error("extension_session_create_failed");
      return { id: String(tab.id), url: String(tab.url || url), active: Boolean(tab.active) };
    }

    async navigateSession(sessionId, url) {
      const id = Number(sessionId);
      if (!Number.isInteger(id)) throw new Error("invalid_extension_session_id");
      const tab = await this.chrome?.tabs?.update?.(id, { url });
      return tab ? { id: String(tab.id), url: String(tab.url || url), active: Boolean(tab.active) } : null;
    }

    async removeSession(sessionId) {
      const id = Number(sessionId);
      if (!Number.isInteger(id) || !this.chrome?.tabs?.remove) return;
      return this.chrome.tabs.remove(id);
    }

    async bindAgentToSession(agentId, session, { status = "CONNECTING", chatUrl = "" } = {}) {
      const tabId = Number(session?.id);
      if (!Number.isInteger(tabId)) return null;
      return this.registry?.bindAgent?.(agentId, {
        tabId,
        chatUrl: String(chatUrl || session?.url || ""),
        status
      });
    }

    async createAgentForSession({ role, session, chatUrl = "", label = "", status = "CONNECTING" } = {}) {
      const tabId = Number(session?.id);
      if (!Number.isInteger(tabId)) return null;
      return this.registry?.createAgent?.({ role, tabId, chatUrl: String(chatUrl || session?.url || ""), label, status });
    }

    async markSessionOffline(sessionId, reason = "session_unavailable") {
      const id = Number(sessionId);
      if (!Number.isInteger(id)) return null;
      return this.registry?.markOfflineByTabId?.(id, reason);
    }

    async updateSessionNavigation(sessionId, url) {
      const id = Number(sessionId);
      if (!Number.isInteger(id)) return null;
      return this.registry?.updateNavigation?.(id, url);
    }

    async updateHeartbeat(sessionId, payload = {}, url = "") {
      const id = Number(sessionId);
      if (!Number.isInteger(id)) return null;
      return this.registry?.updateHeartbeat?.(id, payload, url);
    }

    async sendSessionMessage(sessionId, message) {
      const id = Number(sessionId);
      if (!Number.isInteger(id)) return { ok: false, reason: "invalid_extension_session_id" };
      return this.chrome?.tabs?.sendMessage?.(id, message);
    }

    async pingAgent(agentId) {
      const agent = this.getAgent(agentId);
      const sessionId = this.sessionIdForAgent(agent);
      if (!sessionId) return { ok: false, reason: "agent_offline" };
      try {
        const response = await this.sendSessionMessage(sessionId, { type: this.messageTypes.PING, payload: { agentId } });
        const updated = await this.updateHeartbeat(sessionId, response?.payload || response || {}, agent?.chatUrl || "");
        return { ok: true, agent: updated || this.getAgent(agentId) };
      } catch (error) {
        return { ok: false, reason: "content_not_ready", message: asError(error) };
      }
    }

    async sendPrompt(agentId, prompt) {
      const sessionId = this.sessionIdForAgent(agentId);
      if (!sessionId) return { ok: false, reason: "agent_offline", agentId };
      try {
        const result = await this.sendSessionMessage(sessionId, {
          type: this.messageTypes.SEND_PROMPT,
          payload: { prompt: String(prompt || "") }
        });
        return { ...(result || {}), agentId };
      } catch (error) {
        return { ok: false, reason: "agent_unreachable", message: asError(error), agentId };
      }
    }

    async stopAgent(agentId) {
      const sessionId = this.sessionIdForAgent(agentId);
      if (!sessionId) return { ok: false, reason: "agent_offline", agentId };
      try {
        const result = await this.sendSessionMessage(sessionId, {
          type: this.messageTypes.STOP_GENERATION,
          payload: { agentId }
        });
        return { ...(result || {}), agentId };
      } catch (error) {
        return { ok: false, reason: "agent_unreachable", message: asError(error), agentId };
      }
    }
  }

  class ChromeAlarmRuntime {
    constructor({ chromeApi = globalThis.chrome } = {}) {
      this.chrome = chromeApi;
      this.listeners = new Map();
      this.bound = false;
    }

    ensureListener() {
      if (this.bound || !this.chrome?.alarms?.onAlarm?.addListener) return;
      this.bound = true;
      this.chrome.alarms.onAlarm.addListener((alarm) => {
        const listener = this.listeners.get(alarm?.name);
        if (listener) Promise.resolve(listener(alarm)).catch(() => {});
      });
    }

    scheduleRecurring(name, { periodMinutes = 1 } = {}, listener) {
      const key = String(name || "").trim();
      if (!key || typeof listener !== "function") throw new TypeError("invalid_recurring_timer");
      this.ensureListener();
      this.listeners.set(key, listener);
      this.chrome?.alarms?.create?.(key, { periodInMinutes: Math.max(1, Number(periodMinutes) || 1) });
      return () => this.cancel(key);
    }

    async cancel(name) {
      const key = String(name || "");
      this.listeners.delete(key);
      if (this.chrome?.alarms?.clear) await this.chrome.alarms.clear(key);
    }
  }

  root.ChromeStorageStateStore = ChromeStorageStateStore;
  root.ExtensionAgentRuntime = ExtensionAgentRuntime;
  root.ChromeAlarmRuntime = ChromeAlarmRuntime;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { ChromeStorageStateStore, ExtensionAgentRuntime, ChromeAlarmRuntime, CHATGPT_HOME };
  }
})();
