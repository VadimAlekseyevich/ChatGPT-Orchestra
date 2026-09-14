const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { ALPHA_VERSION, ALPHA_ARTIFACT_NAME, ALPHA_SCENARIOS, MANUAL_SCENARIO_IDS } = require("../scripts/alpha-release-contract.js");

const ROOT = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");
const pkg = JSON.parse(read("package.json"));
const manifest = JSON.parse(read("manifest.json"));
const ci = read(".github/workflows/ci.yml");
const validationDoc = read("docs/alpha-20-validation.md");

test("Phase 20 alpha contract contains exactly the 17 roadmap scenarios", () => {
  assert.equal(ALPHA_SCENARIOS.length, 17);
  assert.deepEqual(ALPHA_SCENARIOS.map((scenario) => scenario.id), Array.from({ length: 17 }, (_, index) => `A${String(index + 1).padStart(2, "0")}`));
  assert.equal(new Set(ALPHA_SCENARIOS.map((scenario) => scenario.title)).size, 17);
  assert.deepEqual(MANUAL_SCENARIO_IDS, ["A01", "A11"]);
});

test("every alpha scenario has executable automated evidence in the Phase 20 gate", () => {
  const phase20 = String(pkg.scripts?.["test:phase20"] || "");
  assert.ok(phase20.startsWith("node --test "), "phase20_test_gate_missing");
  for (const scenario of ALPHA_SCENARIOS) {
    assert.ok(Array.isArray(scenario.evidence) && scenario.evidence.length > 0, `alpha_evidence_missing:${scenario.id}`);
    for (const relative of scenario.evidence) {
      assert.ok(fs.existsSync(path.join(ROOT, relative)), `alpha_evidence_file_missing:${scenario.id}:${relative}`);
      assert.ok(phase20.includes(relative), `alpha_evidence_not_in_phase20_gate:${scenario.id}:${relative}`);
    }
  }
  assert.ok(phase20.includes("tests/phase20-alpha-scenarios.test.js"));
});

test("alpha version, manifest and Windows artifact naming are consistent", () => {
  assert.equal(pkg.version, ALPHA_VERSION);
  assert.equal(manifest.version_name, ALPHA_VERSION);
  assert.ok(ci.includes(`$manifest.version_name -ne \"${ALPHA_VERSION}\"`));
  assert.ok(ci.includes(`name: ${ALPHA_ARTIFACT_NAME}`));
  assert.ok(ci.includes("npm run test:phase20"));
});

test("operator validation document covers every roadmap scenario and preserves manual gates", () => {
  for (const scenario of ALPHA_SCENARIOS) {
    assert.ok(validationDoc.includes(scenario.id), `alpha_validation_doc_missing_id:${scenario.id}`);
    assert.ok(validationDoc.includes(scenario.title), `alpha_validation_doc_missing_title:${scenario.id}`);
  }
  assert.ok(validationDoc.includes("A01 and A11 require real manual evidence"));
  assert.ok(validationDoc.includes("Issue #26 remains deferred"));
});
