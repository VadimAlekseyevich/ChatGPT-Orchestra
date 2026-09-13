const test = require("node:test");
const assert = require("node:assert/strict");

require("../background/git-provider.js");
const Policy = require("../background/integration-policy.js");

function task(id, dependencies = [], extras = {}) {
  return {
    id,
    title: extras.title || id,
    objective: extras.objective || `Implement ${id}`,
    dependencies,
    priority: extras.priority || 0,
    kind: extras.kind || "code",
    subsystem: extras.subsystem || null,
    verification: extras.verification || ["npm test"],
    lastArtifact: extras.lastArtifact || null
  };
}

test("deterministic integration order respects DAG before category preferences", () => {
  const result = Policy.deterministicIntegrationOrder([
    task("consumer", ["api"], { title: "Consumer UI", priority: 100 }),
    task("docs", [], { title: "Documentation", kind: "docs" }),
    task("api", [], { title: "API schema contract" })
  ]);
  assert.equal(result.ok, true);
  assert.ok(result.order.indexOf("api") < result.order.indexOf("consumer"));
  assert.ok(result.order.indexOf("api") < result.order.indexOf("docs"));
});

test("text conflict attribution uses changed-file ownership and current task", () => {
  const tasks = [
    task("T1", [], { lastArtifact: { changedFiles: ["src/shared.js"] } }),
    task("T2", [], { lastArtifact: { changedFiles: ["src/shared.js", "src/two.js"] } }),
    task("T3", [], { lastArtifact: { changedFiles: ["src/other.js"] } })
  ];
  const normalized = Policy.normalizeConflictPayload({
    conflictType: "text",
    currentTaskId: "T2",
    mergedTaskIds: ["T1"],
    files: ["src/shared.js"],
    responsibleTaskIds: [],
    summary: "content conflict"
  }, ["T1", "T2", "T3"]);
  assert.equal(normalized.ok, true);
  const owners = Policy.identifyResponsibleTasks(normalized.conflict, tasks, ["T1", "T2", "T3"]);
  assert.deepEqual(owners, ["T1", "T2"]);
  assert.equal(Policy.validateMergeProgress(normalized.conflict, ["T1", "T2", "T3"]).ok, true);
});

test("semantic conflict requires failed checks and preserves explicit responsible tasks", () => {
  const normalized = Policy.normalizeConflictPayload({
    conflictType: "semantic",
    mergedTaskIds: ["T1", "T2"],
    responsibleTaskIds: ["T1", "T2"],
    failedChecks: [{ command: "npm test", evidence: "integration assertion failed" }]
  }, ["T1", "T2"]);
  assert.equal(normalized.ok, true);
  assert.deepEqual(normalized.conflict.responsibleTaskIds, ["T1", "T2"]);

  const invalid = Policy.normalizeConflictPayload({ conflictType: "semantic", responsibleTaskIds: ["T1"] }, ["T1"]);
  assert.equal(invalid.ok, false);
  assert.equal(invalid.reason, "integration_semantic_failed_checks_missing");
});

test("DONE contract requires exact merge order and PASS evidence for every verification command", () => {
  const run = { mergeTaskIds: ["T1", "T2"], verificationCommands: ["npm test", "npm run lint"] };
  const ok = Policy.validateDonePayload({ integration: {
    branch: "orchestra/P/integration/R",
    commit: "d".repeat(40),
    baseSha: "a".repeat(40),
    targetBranch: "main",
    mergedTaskIds: ["T1", "T2"],
    changedFiles: ["src/a.js"],
    checks: [
      { command: "npm test", status: "PASS", evidence: "20 tests passed" },
      { command: "npm run lint", status: "PASS", evidence: "0 errors" }
    ]
  } }, run);
  assert.equal(ok.ok, true);

  const badOrder = Policy.validateDonePayload({ integration: {
    mergedTaskIds: ["T2", "T1"], checks: []
  } }, run);
  assert.equal(badOrder.reason, "integration_merge_order_mismatch");

  const missingEvidence = Policy.validateDonePayload({ integration: {
    mergedTaskIds: ["T1", "T2"], checks: [
      { command: "npm test", status: "PASS", evidence: "ok" },
      { command: "npm run lint", status: "PASS", evidence: "" }
    ]
  } }, run);
  assert.equal(missingEvidence.reason, "integration_verification_incomplete");
});
