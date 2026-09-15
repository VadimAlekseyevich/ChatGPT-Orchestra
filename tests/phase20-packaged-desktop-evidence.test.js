"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { ALPHA_SCENARIOS } = require("../scripts/alpha-release-contract.js");

const ROOT = path.resolve(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

function scenario(id) {
  const item = ALPHA_SCENARIOS.find((candidate) => candidate.id === id);
  assert.ok(item, `scenario_missing:${id}`);
  return item;
}

test("A02 local-open evidence includes the packaged desktop project workflow", () => {
  const evidence = scenario("A02").evidence;
  assert.ok(evidence.includes("tests/desktop-project-onboarding.test.js"));
  assert.ok(evidence.includes("tests/repository-origin-url.test.js"));
  assert.ok(evidence.includes("tests/repository-api.test.js"));
  assert.ok(evidence.includes("tests/project-repository-binding.test.js"));
});

test("A03 clone evidence includes the packaged desktop project workflow plus real Git workspace coverage", () => {
  const evidence = scenario("A03").evidence;
  assert.ok(evidence.includes("tests/desktop-project-onboarding.test.js"));
  assert.ok(evidence.includes("tests/git-cli-workspace.test.js"));
  assert.ok(evidence.includes("tests/system-git-workspace.test.js"));
});

test("all packaged repository evidence is executed by the Phase 20 gate", () => {
  const gate = String(pkg.scripts?.["test:phase20"] || "");
  for (const id of ["A02", "A03"]) {
    for (const evidence of scenario(id).evidence) {
      assert.ok(gate.includes(evidence), `packaged_repository_evidence_not_gated:${id}:${evidence}`);
    }
  }
});
