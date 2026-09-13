const test = require("node:test");
const assert = require("node:assert/strict");

const { FakeAgentRuntime, DeterministicTimerRuntime } = require("../platform/fake-runtime.js");
const {
  ExtensionCompanionModeController,
  COMPANION_MODE_KEY,
  COMPANION_MIGRATION_EXPECTED_KEY,
  LEGACY_PROJECTS_KEY,
  RECONNECT_TIMER
} = require("../platform/extension-companion-mode.js");

class MemoryStorageArea {
  constructor(initial = {}) { this.data = { ...initial }; }
  async get(key) { return { [key]: this.data[key] }; }
  async set(values) { Object.assign(this.data, values || {}); }
}

function controllerFixture({ initial = {}, failStarts = 0, migrationStatus = { ok: true, pending: null, applied: null }, stageResult = null } = {}) {
  const storageArea = new MemoryStorageArea(initial);
  const timerRuntime = new DeterministicTimerRuntime();
  const agentRuntime = new FakeAgentRuntime({ agents: [{ agentId: "lead-1", role: "lead", status: "IDLE" }] });
  const transports = [];
  let remainingFailures = failStarts;

  const controller = new ExtensionCompanionModeController({
    storageArea,
    timerRuntime,
    agentRuntime,
    transportFactory: () => {
      const transport = {
        connected: false,
        getStatus() { return { kind: "fixture", connected: this.connected }; }
      };
      transports.push(transport);
      return transport;
    },
    rpcFactory: (transport) => ({
      transport,
      async request(method) {
        if (method === "migration.status") return migrationStatus;
        if (method === "migration.stageBundle") return stageResult || { ok: true, projectId: "project-local", checksum: "abc", restartRequired: true };
        throw new Error(`unexpected_rpc:${method}`);
      }
    }),
    endpointFactory: (rpc) => ({
      started: false,
      async start() {
        if (remainingFailures > 0) {
          remainingFailures -= 1;
          throw new Error("desktop_unavailable");
        }
        rpc.transport.connected = true;
        this.started = true;
      },
      async stop() {
        rpc.transport.connected = false;
        this.started = false;
      },
      async forwardRuntimeMessage() { return { ok: true, routed: "runtime" }; },
      async forwardApiMessage() { return { ok: true, routed: "api" }; },
      async forwardSessionRemoved() { return { ok: true }; },
      async forwardSessionUpdated() { return { ok: true }; }
    })
  });

  return { controller, storageArea, timerRuntime, transports };
}

test("companion mode is disabled by default and persists explicit enable/disable", async () => {
  const { controller, storageArea, timerRuntime } = controllerFixture();
  assert.equal((await controller.load()).state, "DISABLED");
  assert.equal(timerRuntime.list().includes(RECONNECT_TIMER), false);

  const enabled = await controller.setEnabled(true);
  assert.equal(enabled.connected, true);
  assert.equal(storageArea.data[COMPANION_MODE_KEY], true);
  assert.equal(timerRuntime.list().includes(RECONNECT_TIMER), true);

  const disabled = await controller.setEnabled(false);
  assert.equal(disabled.state, "DISABLED");
  assert.equal(storageArea.data[COMPANION_MODE_KEY], false);
  assert.equal(timerRuntime.list().includes(RECONNECT_TIMER), false);
});

test("active extension project blocks companion cutover until a matching migration is staged and applied", async () => {
  const { controller, storageArea, transports } = controllerFixture({
    initial: {
      [LEGACY_PROJECTS_KEY]: {
        schemaVersion: 1,
        activeProjectId: "project-local",
        projects: { "project-local": { projectId: "project-local" } }
      }
    }
  });
  await controller.load();
  const status = await controller.setEnabled(true);

  assert.equal(status.ok, false);
  assert.equal(status.enableRejected, true);
  assert.equal(status.reason, "companion_enable_requires_project_migration");
  assert.equal(status.activeProjectId, "project-local");
  assert.equal(controller.isEnabled(), false);
  assert.equal(storageArea.data[COMPANION_MODE_KEY], undefined);
  assert.equal(transports.length, 0);
});

test("applied desktop migration receipt with exact staged checksum permits active project cutover", async () => {
  const { controller, storageArea, transports } = controllerFixture({
    initial: {
      [LEGACY_PROJECTS_KEY]: {
        schemaVersion: 1,
        activeProjectId: "project-local",
        projects: { "project-local": { projectId: "project-local" } }
      },
      [COMPANION_MIGRATION_EXPECTED_KEY]: { projectId: "project-local", checksum: "abc", stagedAt: 100 }
    },
    migrationStatus: {
      ok: true,
      pending: null,
      applied: { projectId: "project-local", checksum: "abc", appliedAt: 123 }
    }
  });
  await controller.load();
  const status = await controller.setEnabled(true);

  assert.equal(status.enabled, true);
  assert.equal(status.connected, true);
  assert.equal(storageArea.data[COMPANION_MODE_KEY], true);
  assert.equal(controller.isEnabled(), true);
  assert.equal(transports.length, 2);
});

test("stale desktop receipt for the same project cannot authorize a newer staged snapshot", async () => {
  const { controller, transports } = controllerFixture({
    initial: {
      [LEGACY_PROJECTS_KEY]: {
        schemaVersion: 1,
        activeProjectId: "project-local",
        projects: { "project-local": { projectId: "project-local" } }
      },
      [COMPANION_MIGRATION_EXPECTED_KEY]: { projectId: "project-local", checksum: "new-checksum", stagedAt: 100 }
    },
    migrationStatus: {
      ok: true,
      pending: null,
      applied: { projectId: "project-local", checksum: "old-checksum", appliedAt: 123 }
    }
  });
  await controller.load();
  const status = await controller.setEnabled(true);

  assert.equal(status.enableRejected, true);
  assert.equal(status.reason, "companion_enable_requires_project_migration");
  assert.equal(status.expectedChecksum, "new-checksum");
  assert.equal(controller.isEnabled(), false);
  assert.equal(transports.length, 1);
});

test("migration bundle can be staged over a transient bridge while extension remains canonical", async () => {
  const { controller, storageArea, transports } = controllerFixture({
    stageResult: { ok: true, projectId: "project-local", checksum: "abc", restartRequired: true }
  });
  await controller.load();
  const result = await controller.stageMigrationBundle("bundle-json");

  assert.equal(result.ok, true);
  assert.equal(result.restartRequired, true);
  assert.equal(controller.isEnabled(), false);
  assert.equal(storageArea.data[COMPANION_MIGRATION_EXPECTED_KEY].projectId, "project-local");
  assert.equal(storageArea.data[COMPANION_MIGRATION_EXPECTED_KEY].checksum, "abc");
  assert.equal(transports.length, 1);
  assert.equal(transports[0].connected, false);
});

test("reconnect timer rebuilds a dropped companion endpoint without changing mode", async () => {
  const { controller, timerRuntime, transports } = controllerFixture();
  await controller.load();
  await controller.setEnabled(true);
  assert.equal(transports.length, 1);
  transports[0].connected = false;

  assert.equal(await timerRuntime.fire(RECONNECT_TIMER), true);
  assert.equal(transports.length, 2);
  assert.equal(controller.getStatus().connected, true);
  assert.equal(controller.isEnabled(), true);
});

test("enabled companion mode fails closed when desktop is unavailable", async () => {
  const { controller, storageArea } = controllerFixture({ failStarts: 2 });
  await controller.load();
  const status = await controller.setEnabled(true);

  assert.equal(status.enabled, true);
  assert.equal(status.connected, false);
  assert.equal(status.lastError, "desktop_unavailable");
  assert.equal(storageArea.data[COMPANION_MODE_KEY], true);
  await assert.rejects(() => controller.forwardApiMessage({ type: "query" }, {}), /desktop_unavailable/);
  assert.equal(controller.isEnabled(), true);
});

test("stored companion mode restores and connects on service-worker boot", async () => {
  const { controller } = controllerFixture({ initial: { [COMPANION_MODE_KEY]: true } });
  const status = await controller.load();
  assert.equal(status.enabled, true);
  assert.equal(status.connected, true);
});
