const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { ManagedBrowserAgentRuntime } = require("../apps/desktop/main/managed-browser-agent-runtime.js");

class Driver {
  constructor() { this.sessions = new Map(); this.next = 1; }
  async start() { return { ok: true }; }
  async close() {}
  async getActiveSession() { return [...this.sessions.values()][0] || null; }
  async getSession(id) { return this.sessions.get(String(id)) || null; }
  async createSession({ url = "about:blank", active = false } = {}) { const session = { id: `S${this.next++}`, url, active }; this.sessions.set(session.id, session); return { ...session }; }
  async navigateSession(id, url) { const session = this.sessions.get(String(id)); session.url = url; return { ...session }; }
  async removeSession(id) { return this.sessions.delete(String(id)); }
  async activateSession(id) { return { ...this.sessions.get(String(id)), active: true }; }
  async pingSession(id) { return { ok: true, availability: "unavailable", generating: false, url: this.sessions.get(String(id))?.url || "" }; }
  async sendPrompt() { return { ok: false, reason: "page_adapter_unavailable" }; }
  async stopGeneration() { return { ok: false, reason: "page_adapter_unavailable" }; }
}

function harness() {
  const profileDirectory = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-readiness-")), "profile");
  fs.mkdirSync(profileDirectory, { recursive: true });
  const driver = new Driver();
  return { driver, runtime: new ManagedBrowserAgentRuntime({ driver, profileDirectory }) };
}

test("unavailable browser health demotes stale readiness and records chat state", async () => {
  const { runtime } = harness();
  await runtime.load();
  const session = await runtime.createSession({ url: "https://chatgpt.com/" });
  const agent = await runtime.createAgentForSession({ role: "lead", session, status: "IDLE" });
  const ping = await runtime.pingAgent(agent.agentId);
  assert.equal(ping.ok, true);
  assert.equal(ping.availability, "unavailable");
  const refreshed = runtime.getAgent(agent.agentId);
  assert.equal(refreshed.status, "ERROR");
  assert.equal(refreshed.lastError, "unavailable");
  assert.equal(refreshed.chatState.availability, "unavailable");
  assert.equal(refreshed.chatState.generating, false);
  await runtime.close();
});

test("explicit ready health promotes CONNECTING to IDLE and generating promotes to BUSY", async () => {
  const { runtime } = harness();
  await runtime.load();
  const session = await runtime.createSession({ url: "https://chatgpt.com/" });
  const agent = await runtime.createAgentForSession({ role: "worker", session, status: "CONNECTING" });
  await runtime.updateHeartbeat(session.id, { availability: "ready", generating: false });
  assert.equal(runtime.getAgent(agent.agentId).status, "IDLE");
  await runtime.updateHeartbeat(session.id, { availability: "generating", generating: true });
  assert.equal(runtime.getAgent(agent.agentId).status, "BUSY");
  await runtime.close();
});


test("failed browser health ping cannot leave a stale IDLE Lead", async () => {
  const { runtime, driver } = harness();
  await runtime.load();
  const session = await runtime.createSession({ url: "https://chatgpt.com/" });
  const agent = await runtime.createAgentForSession({ role: "lead", session, status: "IDLE" });
  driver.pingSession = async () => ({ ok: false, reason: "agent_preload_timeout" });

  const ping = await runtime.pingAgent(agent.agentId);
  assert.equal(ping.ok, false);
  assert.equal(ping.reason, "agent_preload_timeout");
  const refreshed = runtime.getAgent(agent.agentId);
  assert.equal(refreshed.status, "ERROR");
  assert.equal(refreshed.lastError, "agent_preload_timeout");
  assert.equal(refreshed.chatState.availability, "unavailable");
  await runtime.close();
});
