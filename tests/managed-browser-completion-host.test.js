const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

require("../platform/contracts.js");
const { MemoryStateStore, DeterministicTimerRuntime } = require("../platform/fake-runtime.js");
const { TransactionalStateStore } = require("../platform/transactional-state-store.js");
const { CompletionAwareManagedBrowserRuntime } = require("../apps/desktop/main/completion-aware-managed-browser-runtime.js");
const { createManagedBrowserDesktopHost } = require("../apps/desktop/main/managed-browser-desktop-host.js");

function silentLogger() { return { info() {}, warn() {}, error() {}, log() {} }; }

class CompletionDriver {
  constructor() { this.sessions = new Map(); this.next = 1; this.sent = []; this.snapshots = []; }
  async start() { return { ok: true }; }
  async close() {}
  async getActiveSession() { return [...this.sessions.values()].find((item) => item.active) || null; }
  async getSession(id) { return this.sessions.get(String(id)) || null; }
  async createSession({ url = "https://chatgpt.com/", active = false } = {}) {
    const session = { id: `S${this.next++}`, url, active };
    this.sessions.set(session.id, session);
    return { ...session };
  }
  async navigateSession(id, url) { const value = this.sessions.get(String(id)); value.url = url; return { ...value }; }
  async removeSession(id) { return this.sessions.delete(String(id)); }
  async activateSession(id) { const value = this.sessions.get(String(id)); value.active = true; return { ...value }; }
  async pingSession(id) { const value = this.sessions.get(String(id)); return value ? { ok: true, availability: "ready", generating: false, url: value.url } : { ok: false }; }
  async readAssistantSnapshot() {
    return this.snapshots.shift() || { ok: true, text: "", fingerprint: "", messageCount: 0, pathname: "/", url: "https://chatgpt.com/", availability: "ready", generating: false };
  }
  async sendPrompt(id, prompt) { this.sent.push({ id: String(id), prompt }); return { ok: true, accepted: true }; }
  async stopGeneration() { return { ok: true }; }
}

function store() { return new TransactionalStateStore({ store: new MemoryStateStore() }); }

test("managed browser factory composes the completion-aware runtime by default", async () => {
  const driver = new CompletionDriver();
  const host = await createManagedBrowserDesktopHost({
    dataDirectory: fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-completion-host-")),
    driver,
    stateStore: store(),
    timerRuntime: new DeterministicTimerRuntime(),
    logger: silentLogger(),
    openLoginWindow: false,
    completionOptions: { pollMs: 100, quietMs: 100, timeoutMs: 500, sleep: async () => {} }
  });
  try {
    assert.equal(host.agentRuntime instanceof CompletionAwareManagedBrowserRuntime, true);
    assert.ok(host.managedBrowserCompletionMonitor);
    assert.ok(host.managedBrowserProtocolAdapter);

    const session = await host.agentRuntime.createSession({ url: "https://chatgpt.com/c/test" });
    const agent = await host.agentRuntime.createAgentForSession({ role: "worker", session, status: "IDLE" });
    driver.snapshots.push(
      { ok: true, text: "old", fingerprint: "old", messageCount: 1, pathname: "/c/test", availability: "ready", generating: false },
      { ok: true, text: "new", fingerprint: "new", messageCount: 2, pathname: "/c/test", availability: "generating", generating: true },
      { ok: true, text: "new", fingerprint: "new", messageCount: 2, pathname: "/c/test", availability: "ready", generating: false },
      { ok: true, text: "new", fingerprint: "new", messageCount: 2, pathname: "/c/test", availability: "ready", generating: false }
    );

    const sent = await host.agentRuntime.sendPrompt(agent.agentId, "do work");
    assert.equal(sent.ok, true);
    assert.equal(driver.sent.length, 1);
    const monitored = await host.managedBrowserCompletionMonitor.waitFor(agent.agentId);
    assert.equal(monitored.ok, true);
  } finally {
    await host.close();
  }
});
