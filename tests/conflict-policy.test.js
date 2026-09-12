const test = require("node:test");
const assert = require("node:assert/strict");
const Policy = require("../background/conflict-policy.js");

function task(id, allow, extra = {}) {
  return { id, scope: { allow }, risk: "low", ...extra };
}

test("detects nested file-scope overlap conservatively", () => {
  const left = task("A", ["src/auth/**"]);
  const right = task("B", ["src/auth/tokens/**"]);
  const other = task("C", ["src/payments/**"]);
  assert.equal(Policy.fileScopeOverlap(left, right), true);
  assert.equal(Policy.conflictScore(left, right).mutuallyExclusive, true);
  assert.equal(Policy.fileScopeOverlap(left, other), false);
});

test("broad wildcard scope conflicts with every scoped task", () => {
  const broad = task("ALL", ["**/*"]);
  const narrow = task("N", ["src/payments/**"]);
  assert.deepEqual(Policy.scopePrefixes(broad), [Policy.GLOBAL_SCOPE]);
  assert.equal(Policy.fileScopeOverlap(broad, narrow), true);
  assert.equal(Policy.conflictScore(broad, narrow).mutuallyExclusive, true);
});

test("explicit and inferred shared resources are mutually exclusive", () => {
  const migration = task("M1", ["db/migrations/001.sql"], { title: "Database schema migration" });
  const schema = task("M2", ["db/schema/**"], { objective: "Update schema contract" });
  assert.ok(Policy.resourceKeys(migration).includes("shared:schema"));
  assert.equal(Policy.conflictScore(migration, schema).mutuallyExclusive, true);

  const lockA = task("A", ["src/a/**"], { resourceLocks: ["shared:generated-client"] });
  const lockB = task("B", ["src/b/**"], { resourceLocks: ["shared:generated-client"] });
  assert.equal(Policy.conflictScore(lockA, lockB).mutuallyExclusive, true);
});

test("independent scopes remain parallelizable", () => {
  const a = task("A", ["src/auth/**"]);
  const b = task("B", ["tests/payments/**"]);
  const result = Policy.conflictScore(a, b);
  assert.equal(result.mutuallyExclusive, false);
  assert.equal(result.score, 0);
});
