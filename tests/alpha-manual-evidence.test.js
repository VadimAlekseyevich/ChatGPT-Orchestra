"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  validateEvidenceReference,
  validateCliArgs
} = require("../scripts/validate-alpha-evidence-reference.js");

const a01 = "https://github.com/VadimAlekseyevich/ChatGPT-Orchestra/issues/43#issuecomment-123456789";
const a11 = "https://github.com/VadimAlekseyevich/ChatGPT-Orchestra/issues/43#issuecomment-987654321";

test("manual alpha evidence requires an in-repository GitHub issue-comment permalink", () => {
  const accepted = validateEvidenceReference("A01", a01);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.issueNumber, 43);
  assert.equal(accepted.commentId, 123456789);

  for (const reference of [
    "todo",
    "https://example.com/evidence",
    "http://github.com/VadimAlekseyevich/ChatGPT-Orchestra/issues/43#issuecomment-1",
    "https://github.com/other/repo/issues/43#issuecomment-1",
    "https://github.com/VadimAlekseyevich/ChatGPT-Orchestra/issues/43",
    "https://github.com/VadimAlekseyevich/ChatGPT-Orchestra/issues/43?fake=1#issuecomment-1"
  ]) {
    assert.equal(validateEvidenceReference("A01", reference).ok, false, reference);
  }
});

test("manual alpha release requires distinct A01 and A11 evidence comments", () => {
  const results = validateCliArgs(["A01", a01, "A11", a11]);
  assert.deepEqual(results.map((item) => item.scenarioId), ["A01", "A11"]);
  assert.throws(() => validateCliArgs(["A01", a01, "A11", a01]), /must_be_distinct/);
});

test("only the two roadmap manual scenarios are accepted", () => {
  assert.equal(validateEvidenceReference("A11", a11).ok, true);
  assert.match(validateEvidenceReference("A10", a01).reason, /scenario_invalid/);
  assert.match(validateEvidenceReference("", a01).reason, /scenario_invalid/);
});
