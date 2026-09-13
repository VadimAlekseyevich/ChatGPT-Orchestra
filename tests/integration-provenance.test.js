const test = require("node:test");
const assert = require("node:assert/strict");
require("../background/git-provider.js");
const Policy = require("../background/integration-policy.js");

test("approved mutating task without canonical Git artifact fails integration preflight", () => {
  const result = Policy.deterministicIntegrationOrder([{
    id: "T1",
    title: "Code change",
    kind: "code",
    status: "APPROVED",
    dependencies: [],
    lastArtifact: null
  }]);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "integration_approved_task_artifact_missing");
  assert.equal(result.taskId, "T1");
});

test("approved non-mutating task may participate in ordering without Git artifact", () => {
  const result = Policy.deterministicIntegrationOrder([{
    id: "T1",
    title: "Research task",
    kind: "research",
    status: "APPROVED",
    dependencies: [],
    lastArtifact: null
  }]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.order, ["T1"]);
});
