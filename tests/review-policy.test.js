const test = require("node:test");
const assert = require("node:assert/strict");
const { boundedDiff, validateReviewPayload, MAX_REVIEW_FILE_PATCH_CHARS } = require("../background/review-engine.js");

test("review packet marks an individually truncated patch as incomplete", () => {
  const diff = boundedDiff({
    status: "ahead",
    ahead_by: 1,
    behind_by: 0,
    total_commits: 1,
    files: [{
      filename: "src/large.js",
      status: "modified",
      additions: 1000,
      deletions: 1,
      changes: 1001,
      patch: "x".repeat(MAX_REVIEW_FILE_PATCH_CHARS + 1)
    }]
  });
  assert.equal(diff.truncatedForReviewPacket, true);
});

test("review approval cannot hide required changes behind a PASS verdict", () => {
  const task = { acceptanceCriteria: ["criterion A"] };
  const result = validateReviewPayload("REVIEW_APPROVED", {
    summary: "mostly fine",
    criteria: [{ criterion: "criterion A", status: "PASS", evidence: "evidence" }],
    scopeCheck: { status: "PASS", evidence: "scope evidence" },
    testsAssessment: { status: "PASS", evidence: "tests" },
    issues: [],
    requiredChanges: ["still fix this"]
  }, task);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "approval_contains_blocking_changes");
});
