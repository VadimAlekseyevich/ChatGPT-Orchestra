const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const Contracts = require("../platform/contracts.js");
const { agentRuntimeConformance } = require("./contracts/conformance.js");
const {
  ManagedBrowserAgentRuntime,
  assertManagedBrowserDriver
} = require("../apps/desktop/main/managed-browser-agent-runtime.js");

function clone(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }

class FakeManagedBrowserDriver {
  constructor() {
    this.started = false;
    this.profileDirectory = null;
    this.sessions = new Map();
    this.nextSession = 1;
    this.sent = [];
    this.stopped = [];
    this.listeners = new Set();
  }

  async start({ profileDirectory } = {}) {
    this.started = true;
    this.profileDirectory = profileDirectory;
    return { ok: true };
  }

  async close() { this.started = false; }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event) { for (const listener of [...this.listeners]) listener(clone(event)); }

  async getActiveSession() {
    const session = [...this.sessions.values()].find((item) => item.active) || [...this.sessions.values()][0] || null;
    return clone(session);
  }

  async getSession(sessionId) { return clone(this.sessions.get(String(sessionId)) || null); }

  async createSession({ url = "about:blank", active = false } = {}) {
    const id = `page-${this.nextSession++}`;
    if (active) for (const session of this.sessions.values()) session.active = false;
    const session = { id, url: String(url || ""), active: Boolean(active), title: "ChatGPT" };
    this.sessions.set(id, session);
    return clone(session);
  }

  async navigateSession(sessionId, url) {
    const session = this.sessions.get(String(sessionId));
    if (!session) throw new Error("fake_browser_session_missing");
    session.url = String(url || "");
    return clone(session);
  }

  async removeSession(sessionId) {
    return this.sessions.delete(String(sessionId));
  }

  async activateSession(sessionId) {
    const session = this.sessions.get(String(sessionId));
    if (!session) throw new Error("fake_browser_session_missing");
    for (const item of this.sessions.values()) item.active = false;
    session.active = true;
    return clone(session);
  }

  async pingSession(sessionId) {
    const session = this.sessions.get(String(sessionId));
    if (!session) return { ok: false, reason: "session_unavailable" };
    return { ok: true, availability: "ready", generating: false, url: session.url };
  }

  async sendPrompt(sessionId, prompt) {
    if (!this.sessions.has(String(sessionId))) return { ok: false, reason: "session_unavailable" };
    this.sent.push({ sessionId: String(sessionId), prompt: String(prompt || "") });
    return { ok: true, accepted: true, url: this.sessions.get(String(sessionId)).url };
  }

  async stopGeneration(sessionId) {
    if (!this.sessions.has(String(sessionId))) return { ok: false, reason: "session_unavailable" };
    this.stopped.push(String(sessionId));
    return { ok: true, stopped: true, url: this.sessions.get(String(sessionId)).url };
  }
}

function silentLogger() {
  return { debug() {}, info() {}, warn() {}, error() {}, log() {} };
}

function harness(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-browser-runtime-"));
  const profileDirectory = path.join(root, "orchestra-browser-profile");
  fs.mkdirSync(profileDirectory, { recursive: true });
  const driver = new FakeManagedBrowserDriver();
  const runtime = new ManagedBrowserAgentRuntime({
    driver,
    profileDirectory,
    clock: options.clock || (() => 1000),
    maxAgents: options.maxAgents || 5,
    logger: options.logger || silentLogger()
  });
  return { root, profileDirectory, driver, runtime };
}

test("ManagedBrowserAgentRuntime passes reusable AgentRuntime conformance", async () => {
  const { runtime } = harness();
  Contracts.assertAgentRuntime(runtime);
  await agentRuntimeConformance(runtime);
  await runtime.close();
});

test("managed browser starts with a dedicated Orchestra profile without exposing its path in portable runtime state", async () => {
  const { runtime, driver, profileDirectory } = harness();
  const snapshot = await runtime.load();
  assert.equal(driver.started, true);
  assert.equal(driver.profileDirectory, path.resolve(profileDirectory));
  assert.equal(snapshot.runtimeKind, "desktop-managed-browser");
  assert.equal(JSON.stringify(snapshot).includes(profileDirectory), false);
  assert.equal(Object.prototype.hasOwnProperty.call(snapshot, "profileDirectory"), false);
  await runtime.close();
});

test("logical agent identity survives fresh page replacement and is not the browser session id", async () => {
  const { runtime, driver } = harness();
  await runtime.load();
  const first = await runtime.createSession({ url: "https://chatgpt.com/", active: true });
  const agent = await runtime.createAgentForSession({ role: "worker", session: first, label: "Worker 1", status: "IDLE" });
  assert.ok(agent.agentId);
  assert.notEqual(agent.agentId, first.id);
  assert.deepEqual(runtime.runtimeBinding(agent.agentId), { kind: "desktop-browser", sessionId: first.id });

  const replaced = await runtime.replaceAgentSession(agent.agentId, { url: "https://chatgpt.com/?fresh=1", active: true });
  assert.equal(replaced.ok, true);
  assert.equal(replaced.agent.agentId, agent.agentId);
  assert.notEqual(replaced.agent.sessionId, first.id);
  assert.equal(driver.sessions.has(first.id), false);
  assert.equal(runtime.getAgent(agent.agentId).chatUrl, "https://chatgpt.com/?fresh=1");
  await runtime.close();
});

test("prompt, heartbeat, stop and dashboard activation delegate through opaque browser session ids", async () => {
  let now = 100;
  const { runtime, driver } = harness({ clock: () => ++now });
  await runtime.load();
  const session = await runtime.createSession({ url: "https://chatgpt.com/c/test", active: false });
  const agent = await runtime.createAgentForSession({ role: "lead", session, label: "Lead", status: "IDLE" });

  const sent = await runtime.sendPrompt(agent.agentId, "hello");
  assert.equal(sent.ok, true);
  assert.deepEqual(driver.sent, [{ sessionId: session.id, prompt: "hello" }]);
  assert.equal(runtime.getAgent(agent.agentId).status, "BUSY");

  const pinged = await runtime.pingAgent(agent.agentId);
  assert.equal(pinged.ok, true);
  assert.equal(runtime.getAgent(agent.agentId).status, "IDLE");

  const activated = await runtime.activateAgent(agent.agentId);
  assert.equal(activated.ok, true);
  assert.equal(activated.session.active, true);

  const stopped = await runtime.stopAgent(agent.agentId);
  assert.equal(stopped.ok, true);
  assert.deepEqual(driver.stopped, [session.id]);
  assert.equal(runtime.getAgent(agent.agentId).status, "IDLE");
  await runtime.close();
});

test("browser crash marks logical agents offline without treating browser pages as source of truth", async () => {
  const { runtime, driver } = harness();
  await runtime.load();
  const a = await runtime.createAgentForSession({ role: "lead", session: await runtime.createSession({ url: "https://chatgpt.com/" }), status: "IDLE" });
  const b = await runtime.createAgentForSession({ role: "worker", session: await runtime.createSession({ url: "https://chatgpt.com/" }), status: "IDLE" });

  await runtime.handleDriverEvent({ type: "browser-crashed", reason: "process_exit" });
  assert.equal(runtime.getAgent(a.agentId).status, "OFFLINE");
  assert.equal(runtime.getAgent(b.agentId).status, "OFFLINE");
  assert.equal(runtime.getAgent(a.agentId).sessionId, null);
  assert.equal(runtime.getAgent(b.agentId).sessionId, null);
  assert.equal(runtime.snapshot().runtimeStatus, "offline");
  assert.equal(driver.sessions.size, 2, "runtime must not rewrite driver/browser state during crash accounting");
  await runtime.close();
});

test("managed browser runtime enforces a bounded logical-agent concurrency policy", async () => {
  const { runtime } = harness({ maxAgents: 2 });
  await runtime.load();
  const first = await runtime.createAgentForSession({ role: "lead", session: await runtime.createSession({ url: "https://chatgpt.com/" }) });
  const second = await runtime.createAgentForSession({ role: "worker", session: await runtime.createSession({ url: "https://chatgpt.com/" }) });
  const third = await runtime.createAgentForSession({ role: "worker", session: await runtime.createSession({ url: "https://chatgpt.com/" }) });
  assert.ok(first?.agentId);
  assert.ok(second?.agentId);
  assert.equal(third, null);
  assert.equal(runtime.listAgents().length, 2);
  await runtime.close();
});

test("managed browser driver contract fails closed when an unsafe partial driver is injected", () => {
  assert.throws(() => assertManagedBrowserDriver({ start() {} }), /managed_browser_driver_contract_missing/);
});


test("managed browser diagnostics record lifecycle metadata without prompt or auth-query contents", async () => {
  const entries = [];
  const logger = {
    debug(event, details) { entries.push({ level: "debug", event, details }); },
    info(event, details) { entries.push({ level: "info", event, details }); },
    warn(event, details) { entries.push({ level: "warn", event, details }); },
    error(event, details) { entries.push({ level: "error", event, details }); }
  };
  let now = 1000;
  const { runtime } = harness({ logger, clock: () => ++now });
  await runtime.load();
  const session = await runtime.createSession({
    url: "https://chatgpt.com/c/test?access_token=must-not-log#private",
    active: true
  });
  const agent = await runtime.createAgentForSession({ role: "lead", session, status: "IDLE" });
  await runtime.sendPrompt(agent.agentId, "top secret prompt body");
  await runtime.pingAgent(agent.agentId);
  await runtime.stopAgent(agent.agentId);
  await runtime.close();

  const serialized = JSON.stringify(entries);
  assert.equal(serialized.includes("top secret prompt body"), false);
  assert.equal(serialized.includes("must-not-log"), false);
  assert.ok(entries.some((entry) => entry.event === "managed_browser_prompt_send_started" && entry.details.promptBytes > 0));
  assert.ok(entries.some((entry) => entry.event === "managed_browser_agent_ping_completed"));
  assert.ok(entries.some((entry) => entry.event === "managed_browser_runtime_closed"));
});
