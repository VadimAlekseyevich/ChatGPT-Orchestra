const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

require("../platform/contracts.js");
const { MemoryStateStore, DeterministicTimerRuntime } = require("../platform/fake-runtime.js");
const { TransactionalStateStore } = require("../platform/transactional-state-store.js");
const { ManagedBrowserAgentRuntime } = require("../apps/desktop/main/managed-browser-agent-runtime.js");
const { createManagedBrowserDesktopHost } = require("../apps/desktop/main/managed-browser-desktop-host.js");

function silentLogger() { return { info() {}, warn() {}, error() {}, log() {} }; }

class Driver {
  constructor() { this.sessions = new Map(); this.next = 1; this.startedProfile = null; this.closed = false; }
  async start({ profileDirectory }) { this.startedProfile = profileDirectory; return { ok: true }; }
  async close() { this.closed = true; }
  async getActiveSession() { return [...this.sessions.values()].find((item) => item.active) || null; }
  async getSession(id) { return this.sessions.get(String(id)) || null; }
  async createSession({ url = "about:blank", active = false } = {}) {
    if (active) for (const session of this.sessions.values()) session.active = false;
    const session = { id: `S${this.next++}`, url, active };
    this.sessions.set(session.id, session);
    return { ...session };
  }
  async navigateSession(id, url) { const session = this.sessions.get(String(id)); session.url = url; return { ...session }; }
  async removeSession(id) { return this.sessions.delete(String(id)); }
  async activateSession(id) { const session = this.sessions.get(String(id)); for (const item of this.sessions.values()) item.active = false; session.active = true; return { ...session }; }
  async pingSession(id) { const session = this.sessions.get(String(id)); return session ? { ok: true, availability: "ready", generating: false, url: session.url } : { ok: false, reason: "session_unavailable" }; }
  async sendPrompt(id) { return this.sessions.has(String(id)) ? { ok: true } : { ok: false, reason: "session_unavailable" }; }
  async stopGeneration(id) { return this.sessions.has(String(id)) ? { ok: true } : { ok: false, reason: "session_unavailable" }; }
}

function stateStore() { return new TransactionalStateStore({ store: new MemoryStateStore() }); }

function harness() {
  const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-managed-host-"));
  const profileDirectory = path.join(dataDirectory, "browser-profile");
  fs.mkdirSync(profileDirectory, { recursive: true });
  const driver = new Driver();
  const runtime = new ManagedBrowserAgentRuntime({ driver, profileDirectory });
  return { dataDirectory, profileDirectory, driver, runtime };
}

test("managed browser desktop factory creates visible onboarding ChatGPT session without fake agents", async () => {
  const { dataDirectory, profileDirectory, driver, runtime } = harness();
  const host = await createManagedBrowserDesktopHost({
    dataDirectory,
    agentRuntime: runtime,
    stateStore: stateStore(),
    timerRuntime: new DeterministicTimerRuntime(),
    logger: silentLogger(),
    openLoginWindow: true
  });
  try {
    assert.equal(driver.startedProfile, path.resolve(profileDirectory));
    assert.equal(runtime.listAgents().length, 0, "direct browser host must not seed a fake Lead");
    const session = await runtime.getActiveSession();
    assert.ok(session?.id);
    assert.equal(session.url, "https://chatgpt.com/");
    assert.equal(session.active, true);
    assert.equal(host.managedBrowserOnboardingSession.id, session.id);
  } finally {
    await host.close();
  }
  assert.equal(driver.closed, true);
});

test("managed browser host registers the active onboarding page as a logical Lead through existing Orchestrator API", async () => {
  const { dataDirectory, runtime } = harness();
  const host = await createManagedBrowserDesktopHost({
    dataDirectory,
    agentRuntime: runtime,
    stateStore: stateStore(),
    timerRuntime: new DeterministicTimerRuntime(),
    logger: silentLogger(),
    openLoginWindow: true
  });
  try {
    const registered = await host.execute("registerActiveLead");
    assert.equal(registered.ok, true);
    const lead = runtime.listAgents().find((agent) => agent.role === "lead");
    assert.ok(lead?.agentId);
    assert.equal(lead.status, "IDLE");
    assert.equal(lead.runtimeKind, "desktop-browser");
    const dashboard = await host.query("dashboard");
    assert.equal(dashboard.ok, true);
    assert.equal(dashboard.dashboard.agents.some((agent) => agent.agentId === lead.agentId && agent.connected), true);
  } finally {
    await host.close();
  }
});

test("managed browser factory can boot headlessly without creating onboarding session", async () => {
  const { dataDirectory, runtime, driver } = harness();
  const host = await createManagedBrowserDesktopHost({
    dataDirectory,
    agentRuntime: runtime,
    stateStore: stateStore(),
    timerRuntime: new DeterministicTimerRuntime(),
    logger: silentLogger(),
    openLoginWindow: false
  });
  try {
    assert.equal(driver.sessions.size, 0);
    assert.equal(host.managedBrowserOnboardingSession, null);
  } finally {
    await host.close();
  }
});
