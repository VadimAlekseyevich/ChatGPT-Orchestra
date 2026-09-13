const test = require("node:test");
const assert = require("node:assert/strict");

const { MemoryStateStore } = require("../platform/fake-runtime.js");
const { TransactionalStateStore } = require("../platform/transactional-state-store.js");
const { SQLiteStateStore, loadDatabaseSync } = require("../platform/sqlite-state-store.js");
const { MigrationRegistry } = require("../persistence/migration-registry.js");
const { PortableStateManager, STORE_KEYS, PORTABLE_SCHEMA_VERSION } = require("../persistence/portable-state.js");
const { ProjectBundleService } = require("../persistence/project-bundle.js");

let sqliteAvailable = true;
try { loadDatabaseSync(); } catch (_) { sqliteAvailable = false; }

function projectState(projectId = "P1") {
  return {
    [STORE_KEYS.projects]: {
      schemaVersion: 1,
      activeProjectId: projectId,
      projects: { [projectId]: { projectId, status: "READY_FOR_INTEGRATION", repository: { url: "https://github.com/example/repo" }, initialGoal: { text: "bundle test" } } }
    },
    [STORE_KEYS.scheduler]: { schemaVersion: 1, projectId, status: "READY_FOR_INTEGRATION", tasks: { T1: { id: "T1", status: "APPROVED" } }, runs: {}, decisions: [{ type: "approved" }] },
    [STORE_KEYS.reviews]: { schemaVersion: 1, projectId, reviews: { RV1: { reviewId: "RV1", taskId: "T1", status: "APPROVED" } } },
    [STORE_KEYS.integration]: { schemaVersion: 1, projectId, status: "IDLE", runs: {} },
    [STORE_KEYS.recovery]: { schemaVersion: 1, projectId, status: "PAUSED", issues: [] },
    [STORE_KEYS.events]: { schemaVersion: 1, processedEvents: {}, processedOrder: [], sequences: {}, events: [], rejections: [] },
    [STORE_KEYS.agents]: { schemaVersion: 1, runtimeStatus: "pool_active", agents: { A1: { agentId: "A1", role: "worker", tabId: 77 } } }
  };
}

function portableFor(store, clock = () => 1234) {
  return new PortableStateManager({
    stateStore: store,
    migrations: new MigrationRegistry({ currentVersion: PORTABLE_SCHEMA_VERSION }),
    clock
  });
}

test("Project Bundle validates checksum and detects tampering", async () => {
  const stateStore = new TransactionalStateStore({ store: new MemoryStateStore(projectState()) });
  const service = new ProjectBundleService({ portableStateManager: portableFor(stateStore), clock: () => 2000, sourceHost: "test-extension" });
  const exported = await service.exportBundle({});
  assert.equal(exported.ok, true);
  assert.match(exported.filename, /P1\.bundle\.json$/);
  assert.equal(service.validateBundle(exported.serialized).ok, true);

  const tampered = JSON.parse(exported.serialized);
  tampered.project.status = "MUTATED";
  const checked = service.validateBundle(tampered);
  assert.equal(checked.ok, false);
  assert.equal(checked.reason, "project_bundle_checksum_mismatch");
});

test("Project Bundle contains no required browser session identities", async () => {
  const stateStore = new TransactionalStateStore({ store: new MemoryStateStore(projectState()) });
  const service = new ProjectBundleService({ portableStateManager: portableFor(stateStore) });
  const exported = await service.exportBundle({});
  assert.equal(exported.ok, true);
  assert.equal(exported.serialized.includes("\"tabId\""), false);
  assert.equal(exported.serialized.includes("\"sessionId\""), false);
});

test("extension-shaped state exports and imports into SQLite with identical logical state", { skip: !sqliteAvailable }, async () => {
  const sourceStore = new TransactionalStateStore({ store: new MemoryStateStore(projectState()) });
  const exporter = new ProjectBundleService({ portableStateManager: portableFor(sourceStore), sourceHost: "edge-extension" });
  const exported = await exporter.exportBundle({});
  assert.equal(exported.ok, true);

  const sqlite = new SQLiteStateStore({ filename: ":memory:" });
  try {
    const importer = new ProjectBundleService({ portableStateManager: portableFor(sqlite), sourceHost: "node-sqlite" });
    const imported = await importer.importBundle(exported.serialized);
    assert.equal(imported.ok, true);
    assert.equal(imported.recoveryRequired, true);

    const restored = await sqlite.get(Object.values(STORE_KEYS));
    assert.equal(restored[STORE_KEYS.projects].projects.P1.initialGoal.text, "bundle test");
    assert.equal(restored[STORE_KEYS.scheduler].tasks.T1.status, "APPROVED");
    assert.equal(restored[STORE_KEYS.reviews].reviews.RV1.status, "APPROVED");
    assert.equal(restored[STORE_KEYS.integration].projectId, "P1");
    assert.equal(restored[STORE_KEYS.recovery].status, "RECOVERY_REQUIRED");
    assert.deepEqual(restored[STORE_KEYS.agents].agents, {});
  } finally {
    sqlite.close();
  }
});
