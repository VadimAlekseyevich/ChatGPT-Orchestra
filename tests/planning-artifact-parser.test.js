const test = require("node:test");
const assert = require("node:assert/strict");
const Parser = require("../content/planning-artifact-parser.js");

test("parses a multiline planning artifact before the final protocol event", () => {
  const text = [
    "analysis text",
    Parser.BEGIN,
    "{\n  \"stack\": \"js\",\n  \"tests\": [\"npm test\"]\n}",
    Parser.END,
    '@@ORCH {"v":1,"event":"DONE"}'
  ].join("\n");
  const result = Parser.parsePlanningArtifact(text);
  assert.equal(result.ok, true);
  assert.equal(result.artifact.stack, "js");
  assert.deepEqual(result.artifact.tests, ["npm test"]);
});

test("rejects missing markers, malformed JSON and arrays", () => {
  assert.equal(Parser.parsePlanningArtifact("{}").reason, "planning_artifact_markers_missing");
  assert.equal(Parser.parsePlanningArtifact(`${Parser.BEGIN}\n{bad\n${Parser.END}`).reason, "planning_artifact_invalid_json");
  assert.equal(Parser.parsePlanningArtifact(`${Parser.BEGIN}\n[]\n${Parser.END}`).reason, "planning_artifact_not_object");
});

test("rejects an oversized artifact", () => {
  const text = `${Parser.BEGIN}\n${JSON.stringify({ value: "x".repeat(200) })}\n${Parser.END}`;
  assert.equal(Parser.parsePlanningArtifact(text, { maxLength: 50 }).reason, "planning_artifact_too_large");
});
