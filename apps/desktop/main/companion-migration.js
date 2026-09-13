"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { SQLiteStateStore } = require("../../../platform/sqlite-state-store.js");
const { MigrationRegistry } = require("../../../persistence/migration-registry.js");
const { PortableStateManager, PORTABLE_SCHEMA_VERSION } = require("../../../persistence/portable-state.js");
const { ProjectBundleService, MAX_BUNDLE_BYTES } = require("../../../persistence/project-bundle.js");

const MIGRATION_HANDOFF_VERSION = 1;

function safeReadJson(filename) {
  try {
    return JSON.parse(fs.readFileSync(filename, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function atomicWriteJson(filename, value) {
  const directory = path.dirname(filename);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = `${filename}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try { fs.chmodSync(temporary, 0o600); } catch (_) {}
  fs.renameSync(temporary, filename);
  try { fs.chmodSync(filename, 0o600); } catch (_) {}
}

function removeIfPresent(filename) {
  try { fs.unlinkSync(filename); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
}

function migrationStatus(paths) {
  const pending = safeReadJson(paths.companionMigrationPendingFile);
  const receipt = safeReadJson(paths.companionMigrationReceiptFile);
  return {
    pending: pending ? {
      projectId: pending.projectId || null,
      checksum: pending.checksum || null,
      stagedAt: pending.stagedAt || null
    } : null,
    applied: receipt ? {
      projectId: receipt.projectId || null,
      checksum: receipt.checksum || null,
      appliedAt: receipt.appliedAt || null,
      backupId: receipt.backupId || null
    } : null
  };
}

function stageCompanionMigration({ paths, bundle, validateBundle, clock = () => Date.now() } = {}) {
  if (!paths?.companionMigrationPendingFile || !paths?.companionMigrationReceiptFile) throw new TypeError("companion_migration_paths_required");
  if (typeof validateBundle !== "function") throw new TypeError("companion_migration_validator_required");
  const serialized = typeof bundle === "string" ? bundle : JSON.stringify(bundle);
  if (Buffer.byteLength(serialized, "utf8") > MAX_BUNDLE_BYTES) return { ok: false, reason: "project_bundle_too_large" };

  const checked = validateBundle(serialized);
  if (!checked?.ok) return checked || { ok: false, reason: "project_bundle_invalid" };
  const checksum = String(checked.bundle?.manifest?.checksum || "");
  const pending = {
    schemaVersion: MIGRATION_HANDOFF_VERSION,
    projectId: checked.projectId,
    checksum,
    stagedAt: clock(),
    bundle: serialized
  };

  atomicWriteJson(paths.companionMigrationPendingFile, pending);
  const priorReceipt = safeReadJson(paths.companionMigrationReceiptFile);
  if (priorReceipt && (priorReceipt.projectId !== checked.projectId || priorReceipt.checksum !== checksum)) {
    removeIfPresent(paths.companionMigrationReceiptFile);
  }
  return {
    ok: true,
    projectId: checked.projectId,
    checksum,
    restartRequired: true,
    status: migrationStatus(paths)
  };
}

function createStandaloneBundleService({ stateStore, clock = () => Date.now() } = {}) {
  const migrations = new MigrationRegistry({ currentVersion: PORTABLE_SCHEMA_VERSION });
  const portableStateManager = new PortableStateManager({ stateStore, migrations, clock });
  return new ProjectBundleService({ portableStateManager, clock, sourceHost: "desktop-migration" });
}

async function applyPendingCompanionMigration({ paths, clock = () => Date.now(), logger = console, stateStoreFactory = null } = {}) {
  if (!paths?.companionMigrationPendingFile || !paths?.companionMigrationReceiptFile || !paths?.stateDatabase) {
    throw new TypeError("companion_migration_paths_required");
  }
  const pending = safeReadJson(paths.companionMigrationPendingFile);
  if (!pending) return { ok: true, applied: false, status: migrationStatus(paths) };
  if (Number(pending.schemaVersion) !== MIGRATION_HANDOFF_VERSION || typeof pending.bundle !== "string") {
    return { ok: false, reason: "companion_migration_pending_invalid", status: migrationStatus(paths) };
  }

  const store = stateStoreFactory ? stateStoreFactory(paths) : new SQLiteStateStore({ filename: paths.stateDatabase, clock });
  try {
    const service = createStandaloneBundleService({ stateStore: store, clock });
    const checked = service.validateBundle(pending.bundle);
    if (!checked.ok) return { ...checked, applied: false, status: migrationStatus(paths) };
    const checksum = String(checked.bundle?.manifest?.checksum || "");
    if (checked.projectId !== pending.projectId || checksum !== pending.checksum) {
      return { ok: false, reason: "companion_migration_pending_identity_mismatch", applied: false, status: migrationStatus(paths) };
    }

    const imported = await service.importBundle(pending.bundle, { replace: false, freezeAfter: true });
    if (!imported.ok) return { ...imported, applied: false, status: migrationStatus(paths) };

    const receipt = {
      schemaVersion: MIGRATION_HANDOFF_VERSION,
      projectId: imported.projectId,
      checksum,
      backupId: imported.backupId || null,
      appliedAt: clock(),
      recoveryRequired: imported.recoveryRequired === true
    };
    atomicWriteJson(paths.companionMigrationReceiptFile, receipt);
    removeIfPresent(paths.companionMigrationPendingFile);
    logger.info?.("companion_migration_applied", { projectId: receipt.projectId, checksum: receipt.checksum });
    return { ok: true, applied: true, ...receipt, status: migrationStatus(paths) };
  } finally {
    store.close?.();
  }
}

module.exports = {
  MIGRATION_HANDOFF_VERSION,
  safeReadJson,
  atomicWriteJson,
  migrationStatus,
  stageCompanionMigration,
  createStandaloneBundleService,
  applyPendingCompanionMigration
};
