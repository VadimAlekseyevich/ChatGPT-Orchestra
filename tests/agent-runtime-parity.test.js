const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

require("../content/message-types.js");
const { TabRegistry } = require("../background/tab-registry.js");
const { MemoryStateStore } = require("../platform/fake-runtime.js");
const { ExtensionAgentRuntime } = require("../platform/extension-runtime.js");
const { ManagedBrowserAgentRuntime } = require("../apps/desktop/main/managed-browser-agent-runtime.js");
const { agentRuntimeConformance } = require("./contracts/conformance.js");

function fakeChrome() {
  let nextId = 1;
  const tabs = new Map();
  return {
    tabs: {
      async query() { const active = [...tabs.values()].find((tab) => tab.active); return active ? [{ ...active }] : []; },
      async get(id) { const tab = tabs.get(Number(id)); return tab ? { ...tab } : null; },
      async create({ url = "about:blank", active = false } = {}) {
        if (active) for (const tab of tabs.values()) tab.active = false;
        const tab = { id: nextId++, url, active };
        tabs.set(tab.id, tab);
        return { ...tab };
      },
      async update(id, { url } = {}) { const tab = tabs.get(Number(id)); if (!tab) return null; if (url) tab.url = url; return { ...tab }; },
      async remove(id) { tabs.delete(Number(id)); },
      async sendMessage(_id, message = {}) {
        const type = String(message.type || "");
        if (type === "orchestra/ping") return { ok: true, payload: { availability: "ready", generating: false } };
        if (type === "orchestra/send-prompt") return { ok: true, accepted: true };
        if (type === "orchestra/stop-generation") return { ok: true, stopped: true };
        return { ok: true };
      }
    }
  };
}

class ManagedDriver {
  constructor() { this.sessions = new Map(); this.next = 1; }
  async start() { return { ok: true }; }
  async close() {}
  async getActiveSession() { return [...this.sessions.values()].find((item) => item.active) || null; }
  async getSession(id) { const item = this.sessions.get(String(id)); return item ? { ...item } : null; }
  async createSession({ url = "about:blank", active = false } = {}) {
    if (active) for (const item of this.sessions.values()) item.active = false;
    const session = { id: `page-${this.next++}`, url, active };
    this.sessions.set(session.id, session);
    return { ...session };
  }
  async navigateSession(id, url) { const item = this.sessions.get(String(id)); item.url = url; return { ...item }; }
  async removeSession(id) { return this.sessions.delete(String(id)); }
  async activateSession(id) { const item = this.sessions.get(String(id)); item.active = true; return { ...item }; }
  async pingSession(id) { return this.sessions.has(String(id)) ? { ok: true, availability: "ready", generating: false } : { ok: false }; }
  async sendPrompt(id) { return this.sessions.has(String(id)) ? { ok: true, accepted: true } : { ok: false }; }
  async stopGeneration(id) { return this.sessions.has(String(id)) ? { ok: true, stopped: true } : { ok: false }; }
}

function extensionRuntime() {
  let nextAgent = 1;
  const registry = new TabRegistry({
    stateStore: new MemoryStateStore(),
    idFactory: () => `ext-agent-${nextAgent++}`
  });
  return new ExtensionAgentRuntime({
    chromeApi: fakeChrome(),
    registry,
    messageTypes: globalThis.ChatGPTOrchestra.MESSAGE_TYPES
  });
}

function managedRuntime() {
  return new ManagedBrowserAgentRuntime({
    driver: new ManagedDriver(),
    profileDirectory: fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-parity-profile-")),
    agentIdPrefix: "managed-agent"
  });
}

test("ExtensionAgentRuntime and ManagedBrowserAgentRuntime pass the same portable contract", async () => {
  const extension = extensionRuntime();
  const managed = managedRuntime();
  await agentRuntimeConformance(extension);
  await agentRuntimeConformance(managed);
  await managed.close();
});

test("extension tab senders and managed page senders normalize to the same agent-session boundary", async () => {
  const extension = extensionRuntime();
  await extension.load();
  const extSession = await extension.createSession({ url: "https://chatgpt.com/", active: true });
  const extAgent = await extension.createAgentForSession({ role: "lead", session: extSession, status: "IDLE" });
  const extSender = extension.normalizeSender({ tab: { id: Number(extSession.id), url: extSession.url } });

  const managed = managedRuntime();
  await managed.load();
  const managedSession = await managed.createSession({ url: "https://chatgpt.com/", active: true });
  const managedAgent = await managed.createAgentForSession({ role: "lead", session: managedSession, status: "IDLE" });
  const managedSender = managed.normalizeSender({ sessionId: managedSession.id, url: managedSession.url });

  assert.equal(extSender.kind, "agent-session");
  assert.equal(managedSender.kind, "agent-session");
  assert.equal(extSender.agentId, extAgent.agentId);
  assert.equal(managedSender.agentId, managedAgent.agentId);
  assert.ok(extSender.sessionId);
  assert.ok(managedSender.sessionId);
  assert.equal(managedSender.legacyTabId, null);

  await managed.close();
});
