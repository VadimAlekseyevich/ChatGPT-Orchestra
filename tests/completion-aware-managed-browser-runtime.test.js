const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { CompletionAwareManagedBrowserRuntime } = require("../apps/desktop/main/completion-aware-managed-browser-runtime.js");

class FakeDriver {
  constructor() {
    this.sessions = new Map();
    this.sent = [];
    this.stopped = [];
    this.next = 1;
  }
  async start() { return { ok: true }; }
  async close() {}
  async getActiveSession() { return [...this.sessions.values()][0] || null; }
  async getSession(id) { return this.sessions.get(String(id)) || null; }
  async createSession({ url = "https://chatgpt.com/", active = false } = {}) {
    const session = { id: `S${this.next++}`, url, active };
    this.sessions.set(session.id, session);
    return { ...session };
  }
  async navigateSession(id, url) { const item = this.sessions.get(String(id)); item.url = url; return { ...item }; }
  async removeSession(id) { return this.sessions.delete(String(id)); }
  async activateSession(id) { const item = this.sessions.get(String(id)); item.active = true; return { ...item }; }
  async pingSession(id) { return this.sessions.has(String(id)) ? { ok: true, availability: "ready", generating: false } : { ok: false }; }
  async sendPrompt(id, prompt) { this.sent.push({ id: String(id), prompt }); return { ok: true, accepted: true }; }
  async stopGeneration(id) { this.stopped.push(String(id)); return { ok: true, stopped: true }; }
}

function profileDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-completion-runtime-"));
}

async function runtimeWith(monitor) {
  const driver = new FakeDriver();
  const runtime = new CompletionAwareManagedBrowserRuntime({
    driver,
    completionMonitor: monitor,
    profileDirectory: profileDirectory(),
    clock: (() => { let now = 0; return () => ++now; })()
  });
  await runtime.load();
  const session = await runtime.createSession({ url: "https://chatgpt.com/c/test" });
  const agent = await runtime.createAgentForSession({ role: "worker", session, status: "IDLE" });
  return { runtime, driver, session, agent };
}

test("completion-aware runtime refuses to send when baseline monitoring is unavailable", async () => {
  const monitor = {
    async prepare() { return { ok: false, reason: "agent_preload_timeout" }; },
    start() { throw new Error("unexpected_start"); },
    cancel() { return false; },
    cancelSession() { return 0; },
    close() {}
  };
  const { runtime, driver, agent } = await runtimeWith(monitor);
  const result = await runtime.sendPrompt(agent.agentId, "do work");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "completion_monitor_prepare_failed");
  assert.equal(result.details.reason, "agent_preload_timeout");
  assert.equal(driver.sent.length, 0);
  await runtime.close();
});

test("completion-aware runtime starts monitoring only after the prompt is accepted", async () => {
  const order = [];
  const monitor = {
    async prepare(_runtime, agentId) { order.push(`prepare:${agentId}`); return { ok: true, agentId, sessionId: "S1", baseline: { ok: true } }; },
    start(_runtime, agentId) { order.push(`start:${agentId}`); return { ok: true, token: 7 }; },
    cancel() { return false; },
    cancelSession() { return 0; },
    close() {}
  };
  const { runtime, driver, agent } = await runtimeWith(monitor);
  const originalSend = driver.sendPrompt.bind(driver);
  driver.sendPrompt = async (...args) => { order.push(`send:${agent.agentId}`); return originalSend(...args); };

  const result = await runtime.sendPrompt(agent.agentId, "do work");
  assert.equal(result.ok, true);
  assert.equal(result.completionMonitor.active, true);
  assert.deepEqual(order, [`prepare:${agent.agentId}`, `send:${agent.agentId}`, `start:${agent.agentId}`]);
  assert.equal(driver.sent.length, 1);
  await runtime.close();
});

test("stop, fresh-page replacement and offline transitions cancel active completion monitoring", async () => {
  const cancellations = [];
  const monitor = {
    async prepare(_runtime, agentId) { return { ok: true, agentId, sessionId: "S1", baseline: { ok: true } }; },
    start() { return { ok: true, token: 1 }; },
    cancel(agentId, reason) { cancellations.push({ kind: "agent", agentId, reason }); return true; },
    cancelSession(sessionId, reason) { cancellations.push({ kind: "session", sessionId, reason }); return 1; },
    close() { cancellations.push({ kind: "close" }); }
  };
  const { runtime, agent, session } = await runtimeWith(monitor);

  await runtime.stopAgent(agent.agentId);
  await runtime.replaceAgentSession(agent.agentId, { url: "https://chatgpt.com/c/fresh" });
  const current = runtime.getAgent(agent.agentId);
  await runtime.markSessionOffline(current.sessionId, "render_process_gone");
  await runtime.close();

  assert.equal(cancellations.some((item) => item.kind === "agent" && item.reason === "generation_stopped"), true);
  assert.equal(cancellations.some((item) => item.kind === "agent" && item.reason === "agent_session_replaced"), true);
  assert.equal(cancellations.some((item) => item.kind === "session" && item.reason === "render_process_gone"), true);
  assert.equal(cancellations.at(-1).kind, "close");
  assert.ok(session.id);
});
