const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { ManagedBrowserAgentRuntime } = require("../apps/desktop/main/managed-browser-agent-runtime.js");

class Driver {
  constructor() { this.sessions = new Map(); this.next = 1; this.listener = null; }
  async start() { return { ok: true }; }
  async close() {}
  subscribe(listener) { this.listener = listener; return () => { this.listener = null; }; }
  async getActiveSession() { return [...this.sessions.values()][0] || null; }
  async getSession(id) { return this.sessions.get(String(id)) || null; }
  async createSession({ url = "about:blank", active = false } = {}) { const session = { id: `S${this.next++}`, url, active }; this.sessions.set(session.id, session); return { ...session }; }
  async navigateSession(id, url) { const session = this.sessions.get(String(id)); session.url = url; return { ...session }; }
  async removeSession(id) { return this.sessions.delete(String(id)); }
  async activateSession(id) { const session = this.sessions.get(String(id)); session.active = true; return { ...session }; }
  async pingSession(id) { return this.sessions.has(String(id)) ? { ok: true, availability: "ready", generating: false, url: this.sessions.get(String(id)).url } : { ok: false }; }
  async sendPrompt() { return { ok: true }; }
  async stopGeneration() { return { ok: true }; }
}

function createRuntime() {
  const profileDirectory = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-runtime-events-")), "profile");
  fs.mkdirSync(profileDirectory, { recursive: true });
  const driver = new Driver();
  const runtime = new ManagedBrowserAgentRuntime({ driver, profileDirectory });
  return { runtime, driver };
}

test("managed browser runtime publishes agent messages through bound host handlers", async () => {
  const { runtime } = createRuntime();
  await runtime.load();
  const session = await runtime.createSession({ url: "https://chatgpt.com/" });
  const agent = await runtime.createAgentForSession({ role: "worker", session, status: "IDLE" });
  const calls = [];
  runtime.bindHostHandlers({
    onRuntimeMessage: async (message, sender) => { calls.push({ message, sender }); return { ok: true, accepted: true }; }
  });
  const result = await runtime.publishRuntimeMessage({ type: "ORCHESTRA_EVENT", payload: { event: { eventId: "E1" } } }, { sessionId: session.id, url: session.url });
  assert.equal(result.accepted, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sender.agentId, agent.agentId);
  assert.equal(calls[0].sender.sessionId, session.id);
  assert.equal(calls[0].sender.kind, "agent-session");
  await runtime.close();
});

test("driver navigation and close events use host lifecycle handlers when bound", async () => {
  const { runtime } = createRuntime();
  await runtime.load();
  const session = await runtime.createSession({ url: "https://chatgpt.com/" });
  await runtime.createAgentForSession({ role: "lead", session, status: "IDLE" });
  const calls = [];
  runtime.bindHostHandlers({
    onSessionUpdated: async (sessionId, changeInfo, current) => { calls.push(["updated", sessionId, changeInfo, current]); return { ok: true }; },
    onSessionRemoved: async (sessionId) => { calls.push(["removed", sessionId]); return { ok: true }; }
  });
  await runtime.handleDriverEvent({ type: "session-navigation", sessionId: session.id, url: "https://chatgpt.com/c/next" });
  await runtime.handleDriverEvent({ type: "session-removed", sessionId: session.id, reason: "window_closed" });
  assert.equal(calls[0][0], "updated");
  assert.equal(calls[0][1], session.id);
  assert.equal(calls[0][2].url, "https://chatgpt.com/c/next");
  assert.equal(calls[1][0], "removed");
  assert.equal(calls[1][1], session.id);
  await runtime.close();
});

test("browser crash delegates every bound session to host recovery before runtime goes offline", async () => {
  const { runtime } = createRuntime();
  await runtime.load();
  const first = await runtime.createSession({ url: "https://chatgpt.com/" });
  const second = await runtime.createSession({ url: "https://chatgpt.com/" });
  await runtime.createAgentForSession({ role: "lead", session: first, status: "IDLE" });
  await runtime.createAgentForSession({ role: "worker", session: second, status: "IDLE" });
  const removed = [];
  runtime.bindHostHandlers({ onSessionRemoved: async (sessionId) => { removed.push(sessionId); return { ok: true }; } });
  await runtime.handleDriverEvent({ type: "browser-crashed", reason: "process_exit" });
  assert.deepEqual(removed.sort(), [first.id, second.id].sort());
  assert.equal(runtime.snapshot().runtimeStatus, "offline");
  await runtime.close();
});
