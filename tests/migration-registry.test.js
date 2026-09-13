const test = require("node:test");
const assert = require("node:assert/strict");
const { MigrationRegistry } = require("../persistence/migration-registry.js");

test("MigrationRegistry applies ordered one-version steps deterministically", () => {
  const registry = new MigrationRegistry({ currentVersion: 3 });
  registry
    .register(1, 2, (value) => ({ ...value, schemaVersion: 2, two: true }))
    .register(2, 3, (value) => ({ ...value, schemaVersion: 3, three: value.two === true }));
  const result = registry.migrate({ schemaVersion: 1 }, { fromVersion: 1 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.applied, [2, 3]);
  assert.deepEqual(result.value, { schemaVersion: 3, two: true, three: true });
});

test("MigrationRegistry fails closed on missing or future paths", () => {
  const registry = new MigrationRegistry({ currentVersion: 3 });
  registry.register(1, 2, (value) => value);
  assert.equal(registry.migrate({}, { fromVersion: 1 }).reason, "migration_path_missing");
  assert.equal(registry.migrate({}, { fromVersion: 4 }).reason, "schema_from_future");
  assert.throws(() => registry.register(1, 3, () => ({})), /invalid_migration_step/);
});
