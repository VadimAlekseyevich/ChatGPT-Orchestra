const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { loadDesktopCore } = require("../apps/desktop/main/core-loader.js");
const { ManagedBrowserAgentRuntime } = require("../apps/desktop/main/managed-browser-agent-runtime.js");
const { ManagedBrowserRecoveryRegistry } = require("../apps/desktop/main/managed-browser-recovery-registry.js");

class Driver {
  constructor() { this.sessions = new Map(); this.next = 1; }
  async start() { return { ok: true }; }
  async close() {}
  async getActiveSession() { return null; }
  async getSession(id) { return this.sessions.get(String(id)) || null; }
  async createSession({ url = "about:blank", active = false } = {}) { const value = { id: `S${this.next++}`, url, active }; this.sessions.set(value.id, value); return { ...value }; }
  async navigateSession(id, url) { const value = this.sessions.get(String(id)); value.url = url; return { ...value }; }
  async removeSession(id) { return this.sessions.delete(String(id)); }
  async activateSession(id) { return { ...this.sessions.get(String(id)), active: true }; }
  async pingSession(id) { return this.sessions.has(String(id)) ? { ok: true, availability: "ready", generating: false } : { ok: false }; }
  async sendPrompt() { return { ok: true }; }
  async stopGeneration() { return { ok: true }; }
}

async function runtimeHarness() {
  const driver = new Driver();
  const runtime = new ManagedBrowserAgentRuntime({
    driver,
    profileDirectory: fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-recovery-profile-"))
  });
  await runtime.load();
  return { runtime, driver };
}

test("recovery compatibility view reports live direct agents without leaking BrowserWindow identity", async () => {
  const { runtime } = await runtimeHarness();
  const session = await runtime.createSession({ url: "https://chatgpt.com/" });
  const agent = await runtime.createAgentForSession({ role: "worker", session, status: "IDLE" });
  const registry = new ManagedBrowserRecoveryRegistry(runtime);

  assert.equal(runtime.getAgent(agent.agentId).tabId, null);
  const recoveryAgent = registry.getAgent(agent.agentId);
  assert.equal(Number.isInteger(recoveryAgent.tabId), true);
  assert.equal(recoveryAgent.sessionId, session.id);
  assert.notEqual(String(recoveryAgent.tabId), session.id);

  await runtime.close();
});

test("recovery preserves offline logical worker so createWorkers rebinds a fresh page to the same agentId", async () => {
  const { runtime } = await runtimeHarness();
  const firstSession = await runtime.createSession({ url: "https://chatgpt.com/" });
  const worker = await runtime.createAgentForSession({ role: "worker", session: firstSession, status: "IDLE" });
  const registry = new ManagedBrowserRecoveryRegistry(runtime);
  await runtime.markSessionOffline(firstSession.id, "render_process_gone");

  assert.equal(registry.getAgent(worker.agentId).tabId, null);
  const removed = await registry.removeAgent(worker.agentId);
  assert.equal(removed, true);
  assert.ok(runtime.getAgent(worker.agentId), "logical direct-browser worker must survive recovery cleanup");

  const root = loadDesktopCore();
  const orchestrator = new root.ServiceWorkerOrchestrator({ agentRuntime: runtime });
  const recreated = await orchestrator.createWorkers(1);
  assert.equal(recreated.ok, true);
  assert.deepEqual(recreated.created, [worker.agentId]);
  const rebound = runtime.getAgent(worker.agentId);
  assert.equal(rebound.agentId, worker.agentId);
  assert.ok(rebound.sessionId);
  assert.notEqual(rebound.sessionId, firstSession.id);
  assert.equal(rebound.chatUrl, "https://chatgpt.com/");

  await runtime.close();
});
