const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { MemoryStateStore } = require("../platform/fake-runtime.js");
const { TransactionalStateStore } = require("../platform/transactional-state-store.js");
const { SQLiteStateStore, loadDatabaseSync } = require("../platform/sqlite-state-store.js");
const { MigrationRegistry } = require("../persistence/migration-registry.js");
const { PortableStateManager, STORE_KEYS, PORTABLE_SCHEMA_VERSION } = require("../persistence/portable-state.js");
const { ProjectBundleService } = require("../persistence/project-bundle.js");
const { ensureDesktopPaths } = require("../apps/desktop/main/app-data.js");
const {
  migrationStatus,
  stageCompanionMigration,
  applyPendingCompanionMigration
} = require("../apps/desktop/main/companion-migration.js");

let sqliteAvailable = true;
try { loadDatabaseSync(); } catch (_) { sqliteAvailable = false; }

function projectState(projectId = "P-MIGRATE") {
  return {
    [STORE_KEYS.projects]: {
      schemaVersion: 1,
      activeProjectId: projectId,
      projects: {
        [projectId]: {
          projectId,
          status: "READY_FOR_INTEGRATION",
          stage: "EXECUTION",
          repository: { url: "https://github.com/example/repo" },
          initialGoal: { text: "migration test" }
        }
      }
    },
    [STORE_KEYS.scheduler]: {
      schemaVersion: 1,
      projectId,
      status: "PAUSED",
      tasks: { T1: { id: "T1", status: "APPROVED" } },
      runs: {},
      decisions: []
    },
    [STORE_KEYS.reviews]: { schemaVersion: 1, projectId, reviews: {} },
    [STORE_KEYS.integration]: { schemaVersion: 1, projectId, status: "IDLE", runs: {} },
    [STORE_KEYS.recovery]: { schemaVersion: 1, projectId, status: "PAUSED", issues: [] },
    [STORE_KEYS.events]: { schemaVersion: 1, processedEvents: {}, processedOrder: [], sequences: {}, events: [], rejections: [] },
    [STORE_KEYS.agents]: { schemaVersion: 1, runtimeStatus: "pool_active", agents: { A1: { agentId: "A1", role: "worker", tabId: 77 } } },
    [STORE_KEYS.context]: { schemaVersion: 1, projectId, leadSummary: null, decisions: [], packetAudit: [] }
  };
}

function portableFor(store, clock = () => 1000) {
  return new PortableStateManager({
    stateStore: store,
    migrations: new MigrationRegistry({ currentVersion: PORTABLE_SCHEMA_VERSION }),
    clock
  });
}

async function validBundle() {
  const source = new TransactionalStateStore({ store: new MemoryStateStore(projectState()) });
  const service = new ProjectBundleService({ portableStateManager: portableFor(source), clock: () => 2000, sourceHost: "edge-extension" });
  const exported = await service.exportBundle({});
  assert.equal(exported.ok, true);
  return { service, exported };
}

test("migration stage validates bundle and writes a durable pending handoff", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-migration-stage-"));
  const paths = ensureDesktopPaths({ dataDirectory: root });
  const { service, exported } = await validBundle();

  const staged = stageCompanionMigration({
    paths,
    bundle: exported.serialized,
    validateBundle: (input) => service.validateBundle(input),
    clock: () => 3000
  });

  assert.equal(staged.ok, true);
  assert.equal(staged.projectId, "P-MIGRATE");
  assert.equal(staged.restartRequired, true);
  assert.equal(fs.existsSync(paths.companionMigrationPendingFile), true);
  assert.equal(fs.existsSync(paths.companionMigrationReceiptFile), false);
  assert.equal(migrationStatus(paths).pending.projectId, "P-MIGRATE");
});

test("desktop boot atomically imports a staged bundle before Core and leaves an applied receipt", { skip: !sqliteAvailable }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-migration-apply-"));
  const paths = ensureDesktopPaths({ dataDirectory: root });
  const { service, exported } = await validBundle();
  const staged = stageCompanionMigration({
    paths,
    bundle: exported.serialized,
    validateBundle: (input) => service.validateBundle(input),
    clock: () => 3000
  });
  assert.equal(staged.ok, true);

  const applied = await applyPendingCompanionMigration({ paths, clock: () => 4000, logger: { info() {} } });
  assert.equal(applied.ok, true);
  assert.equal(applied.applied, true);
  assert.equal(applied.projectId, "P-MIGRATE");
  assert.equal(applied.recoveryRequired, true);
  assert.equal(fs.existsSync(paths.companionMigrationPendingFile), false);
  assert.equal(fs.existsSync(paths.companionMigrationReceiptFile), true);

  const sqlite = new SQLiteStateStore({ filename: paths.stateDatabase });
  try {
    const restored = await sqlite.get(Object.values(STORE_KEYS));
    assert.equal(restored[STORE_KEYS.projects].activeProjectId, "P-MIGRATE");
    assert.equal(restored[STORE_KEYS.projects].projects["P-MIGRATE"].initialGoal.text, "migration test");
    assert.equal(restored[STORE_KEYS.scheduler].tasks.T1.status, "APPROVED");
    assert.equal(restored[STORE_KEYS.recovery].status, "RECOVERY_REQUIRED");
    assert.deepEqual(restored[STORE_KEYS.agents].agents, {});
  } finally {
    sqlite.close();
  }

  const status = migrationStatus(paths);
  assert.equal(status.pending, null);
  assert.equal(status.applied.projectId, "P-MIGRATE");
  assert.equal(status.applied.checksum, staged.checksum);

  const secondBoot = await applyPendingCompanionMigration({ paths, clock: () => 5000, logger: { info() {} } });
  assert.equal(secondBoot.ok, true);
  assert.equal(secondBoot.applied, false);
  assert.equal(secondBoot.status.applied.projectId, "P-MIGRATE");
});

test("corrupt staged migration fails closed and keeps pending evidence for diagnosis", { skip: !sqliteAvailable }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-migration-corrupt-"));
  const paths = ensureDesktopPaths({ dataDirectory: root });
  fs.writeFileSync(paths.companionMigrationPendingFile, JSON.stringify({ schemaVersion: 1, projectId: "P", checksum: "bad", bundle: "{}" }));

  const result = await applyPendingCompanionMigration({ paths, logger: { info() {} } });
  assert.equal(result.ok, false);
  assert.equal(result.applied, false);
  assert.equal(fs.existsSync(paths.companionMigrationPendingFile), true);
  assert.equal(fs.existsSync(paths.companionMigrationReceiptFile), false);
});
