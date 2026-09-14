const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { MemoryStateStore, FakeAgentRuntime, DeterministicTimerRuntime } = require("../platform/fake-runtime.js");
const { TransactionalStateStore } = require("../platform/transactional-state-store.js");
const { DesktopHost, WATCHDOG_NAME } = require("../apps/desktop/main/desktop-host.js");

function silentLogger() {
  return { info() {}, warn() {}, error() {}, log() {} };
}

test("DesktopHost boots the real Core behind injected portable adapters", async () => {
  const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-desktop-host-"));
  const stateStore = new TransactionalStateStore({ store: new MemoryStateStore() });
  const agentRuntime = new FakeAgentRuntime();
  const timerRuntime = new DeterministicTimerRuntime();
  const runtimeEvidence = {
    schemaVersion: 1,
    platform: "win32",
    arch: "x64",
    osRelease: "10.0.26100",
    systemBootTimeUtc: "2026-09-15T00:00:00.000Z"
  };
  const host = new DesktopHost({ dataDirectory, stateStore, agentRuntime, timerRuntime, logger: silentLogger(), runtimeEvidence });

  await host.init();
  const state = await host.query("state");
  const persistence = await host.query("persistence");
  const dashboard = await host.query("dashboard", { eventLimit: 1, decisionLimit: 1 });
  const debug = await host.query("debugBundle", { eventLimit: 1, decisionLimit: 1 });
  assert.equal(state.apiVersion, 4);
  assert.equal(state.ok, true);
  assert.equal(state.state.lead.role, "lead");
  assert.equal(persistence.persistence.backend, "injected");
  assert.deepEqual(persistence.persistence.runtimeEvidence, runtimeEvidence);
  assert.deepEqual(dashboard.dashboard.persistence.runtimeEvidence, runtimeEvidence);
  assert.deepEqual(debug.payload.dashboard.persistence.runtimeEvidence, runtimeEvidence);
  assert.deepEqual(timerRuntime.list(), [WATCHDOG_NAME]);

  await timerRuntime.fire(WATCHDOG_NAME);
  await host.close();
});
