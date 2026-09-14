const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

require("../platform/contracts.js");
const { MemoryStateStore, DeterministicTimerRuntime } = require("../platform/fake-runtime.js");
const { TransactionalStateStore } = require("../platform/transactional-state-store.js");
const { ManagedBrowserAgentRuntime } = require("../apps/desktop/main/managed-browser-agent-runtime.js");
const {
  createManagedBrowserDesktopHost,
  intervalsOverlap,
  observedParallelWorkerRuns
} = require("../apps/desktop/main/managed-browser-desktop-host.js");
const { ManagedBrowserOnboarding } = require("../apps/desktop/renderer/managed-browser-onboarding.js");

function silentLogger() { return { info() {}, warn() {}, error() {}, log() {}, debug() {} }; }
function store() { return new TransactionalStateStore({ store: new MemoryStateStore() }); }
function rootElement() { return { innerHTML: "", addEventListener() {}, removeEventListener() {} }; }

class ValidationDriver {
  constructor() { this.sessions = new Map(); this.next = 1; this.availability = "ready"; }
  async start() { return { ok: true }; }
  async close() {}
  async getActiveSession() { return [...this.sessions.values()].find((item) => item.active) || null; }
  async getSession(id) { return this.sessions.get(String(id)) || null; }
  async createSession({ url = "https://chatgpt.com/", active = false } = {}) {
    if (active) for (const item of this.sessions.values()) item.active = false;
    const session = { id: `private-session-${this.next++}`, url: `${url}?private_marker=do-not-export`, active };
    this.sessions.set(session.id, session);
    return { ...session };
  }
  async navigateSession(id, url) { const item = this.sessions.get(String(id)); item.url = url; return { ...item }; }
  async removeSession(id) { return this.sessions.delete(String(id)); }
  async activateSession(id) { const item = this.sessions.get(String(id)); for (const value of this.sessions.values()) value.active = false; item.active = true; return { ...item }; }
  async pingSession(id) {
    const item = this.sessions.get(String(id));
    return item ? { ok: true, availability: this.availability, generating: false, url: item.url } : { ok: false, reason: "session_unavailable" };
  }
  async sendPrompt() { return { ok: true, accepted: true }; }
  async stopGeneration() { return { ok: true, stopped: true }; }
}

async function hostHarness() {
  const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-managed-validation-"));
  const profileDirectory = path.join(dataDirectory, "private-browser-profile");
  fs.mkdirSync(profileDirectory, { recursive: true });
  const driver = new ValidationDriver();
  const runtime = new ManagedBrowserAgentRuntime({ driver, profileDirectory, clock: () => 12345 });
  const host = await createManagedBrowserDesktopHost({
    dataDirectory,
    agentRuntime: runtime,
    stateStore: store(),
    timerRuntime: new DeterministicTimerRuntime(),
    clock: () => 12345,
    logger: silentLogger(),
    openLoginWindow: true
  });
  return { host, runtime, driver, profileDirectory };
}

test("managed browser validation evidence is identifier-free and export-safe", async () => {
  const { host, profileDirectory } = await hostHarness();
  try {
    const registered = await host.execute("registerManagedBrowserLead");
    assert.equal(registered.ok, true);

    const result = await host.query("managedBrowserValidation");
    assert.equal(result.ok, true);
    assert.equal(result.validation.schemaVersion, 1);
    assert.equal(result.validation.runtimeKind, "desktop-managed-browser");
    assert.equal(result.validation.checks.chatgptReady, true);
    assert.equal(result.validation.checks.leadRegistered, true);
    assert.equal(result.validation.complete, false);

    const exported = await host.execute("exportManagedBrowserValidation");
    assert.equal(exported.ok, true);
    assert.match(exported.filename, /^chatgpt-orchestra-managed-browser-validation-\d+\.json$/);
    assert.deepEqual(JSON.parse(exported.serialized).checks, result.validation.checks);

    const serialized = `${JSON.stringify(result)}\n${exported.serialized}`;
    assert.equal(serialized.includes(profileDirectory), false);
    assert.equal(serialized.includes("private-session-1"), false);
    assert.equal(serialized.includes("private_marker"), false);
    assert.equal(serialized.includes("https://chatgpt.com"), false);
    assert.equal(/sessionId|leadAgentId|agentId|profileDirectory|prompt|responseText|cookie|credential|password|bearer|accessToken/i.test(serialized), false);
  } finally {
    await host.close();
  }
});

test("parallel-run evidence requires overlapping runs on distinct workers", () => {
  const first = { taskId: "T1", agentId: "A1", assignedAt: 10, finishedAt: 30 };
  const overlapping = { taskId: "T2", agentId: "A2", assignedAt: 20, finishedAt: 40 };
  const serial = { taskId: "T3", agentId: "A3", assignedAt: 50, finishedAt: 60 };
  const sameWorker = { taskId: "T4", agentId: "A1", assignedAt: 15, finishedAt: 25 };
  assert.equal(intervalsOverlap(first, overlapping), true);
  assert.equal(intervalsOverlap(first, serial), false);
  assert.equal(observedParallelWorkerRuns([first, serial]), false);
  assert.equal(observedParallelWorkerRuns([first, sameWorker]), false);
  assert.equal(observedParallelWorkerRuns([first, overlapping, serial]), true);
});

test("managed browser onboarding renders and exports safe validation evidence", async () => {
  const root = rootElement();
  const downloads = [];
  const validation = {
    schemaVersion: 1,
    runtimeKind: "desktop-managed-browser",
    capturedAt: 12345,
    complete: false,
    checks: {
      chatgptReady: true,
      leadRegistered: true,
      assistantCompletionObserved: true,
      projectStarted: true,
      planningCompleted: true,
      parallelWorkersObserved: false,
      dependencyGraphObserved: true,
      independentReviewObserved: true,
      integrationVerified: false,
      sessionRecoveryObserved: false,
      recoveryHealthy: true
    },
    state: { chatgptAvailability: "ready", projectStatus: "RUNNING" },
    counts: { workers: 2, tasks: 3 }
  };
  const transport = {
    async query(name) {
      if (name === "managedBrowserStatus") return { ok: true, managedBrowser: { availability: "ready", loginRequired: false, leadRegistered: true, leadStatus: "IDLE" } };
      if (name === "managedBrowserValidation") return { ok: true, validation };
      return { ok: false, reason: "unknown_api_query" };
    },
    async execute(name) {
      if (name === "exportManagedBrowserValidation") return { ok: true, filename: "evidence.json", serialized: JSON.stringify(validation) };
      return { ok: true };
    }
  };
  const onboarding = new ManagedBrowserOnboarding({
    rootElement: root,
    transport,
    download: (filename, serialized) => { downloads.push({ filename, serialized }); return true; }
  });
  await onboarding.refresh();
  assert.match(root.innerHTML, /Live validation evidence/);
  assert.match(root.innerHTML, /ChatGPT page ready/);
  assert.match(root.innerHTML, /Parallel Worker runs observed/);
  assert.match(root.innerHTML, /Export validation evidence/);
  assert.match(root.innerHTML, /IN PROGRESS/);

  const exported = await onboarding.handleAction("export-validation");
  assert.equal(exported.ok, true);
  assert.deepEqual(downloads, [{ filename: "evidence.json", serialized: JSON.stringify(validation) }]);
});
