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
function store() { return new TransactionalStateStore({ store: new MemoryStateStore() }); }

class OnboardingDriver {
  constructor() { this.sessions = new Map(); this.next = 1; this.availability = "unavailable"; this.unsupportedAuthProvider = null; }
  async start() { return { ok: true }; }
  async close() {}
  async getActiveSession() { return [...this.sessions.values()].find((item) => item.active) || null; }
  async getSession(id) { return this.sessions.get(String(id)) || null; }
  async createSession({ url = "https://chatgpt.com/", active = false } = {}) {
    if (active) for (const item of this.sessions.values()) item.active = false;
    const session = { id: `S${this.next++}`, url, active };
    this.sessions.set(session.id, session);
    return { ...session };
  }
  async navigateSession(id, url) { const item = this.sessions.get(String(id)); item.url = url; return { ...item }; }
  async removeSession(id) { return this.sessions.delete(String(id)); }
  async activateSession(id) { const item = this.sessions.get(String(id)); for (const value of this.sessions.values()) value.active = false; item.active = true; return { ...item }; }
  async pingSession(id) {
    const item = this.sessions.get(String(id));
    return item ? { ok: true, availability: this.availability, generating: false, url: item.url, unsupportedAuthProvider: this.unsupportedAuthProvider } : { ok: false, reason: "session_unavailable" };
  }
  async sendPrompt() { return { ok: false, reason: "not_used" }; }
  async stopGeneration() { return { ok: false, reason: "not_used" }; }
}

async function harness() {
  const driver = new OnboardingDriver();
  const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-onboarding-host-"));
  const profileDirectory = path.join(dataDirectory, "browser-profile");
  fs.mkdirSync(profileDirectory, { recursive: true });
  const runtime = new ManagedBrowserAgentRuntime({ driver, profileDirectory });
  const host = await createManagedBrowserDesktopHost({
    dataDirectory,
    agentRuntime: runtime,
    stateStore: store(),
    timerRuntime: new DeterministicTimerRuntime(),
    logger: silentLogger(),
    openLoginWindow: true
  });
  return { host, runtime, driver, profileDirectory };
}

test("managed browser Lead registration is blocked until ChatGPT page is actually ready", async () => {
  const { host, runtime, driver } = await harness();
  try {
    const before = await host.query("managedBrowserStatus");
    assert.equal(before.ok, true);
    assert.equal(before.managedBrowser.loginRequired, true);
    assert.equal(before.managedBrowser.leadRegistered, false);

    const blocked = await host.execute("registerManagedBrowserLead");
    assert.equal(blocked.ok, false);
    assert.equal(blocked.reason, "managed_browser_login_required");
    assert.equal(runtime.listAgents().length, 0);

    driver.availability = "ready";
    const registered = await host.execute("registerManagedBrowserLead");
    assert.equal(registered.ok, true);
    assert.equal(registered.managedBrowser.loginRequired, false);
    assert.equal(registered.managedBrowser.leadRegistered, true);
    assert.ok(registered.managedBrowser.leadAgentId);
  } finally {
    await host.close();
  }
});

test("managed browser status never exposes profile paths or credential material", async () => {
  const { host, profileDirectory } = await harness();
  try {
    const response = await host.query("managedBrowserStatus");
    const serialized = JSON.stringify(response);
    assert.equal(serialized.includes(profileDirectory), false);
    assert.equal(/cookie|credential|password|token/i.test(serialized), false);
  } finally {
    await host.close();
  }
});


test("managed browser status reports only a sanitized unsupported auth provider marker", async () => {
  const { host, driver } = await harness();
  try {
    driver.unsupportedAuthProvider = "google";
    const response = await host.query("managedBrowserStatus");
    assert.equal(response.managedBrowser.unsupportedAuthProvider, "google");
    assert.equal(JSON.stringify(response).includes("accounts.google.com"), false);
  } finally {
    await host.close();
  }
});
