"use strict";

const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");

const ROOT = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");
const pkg = JSON.parse(read("package.json"));
const manifest = JSON.parse(read("manifest.json"));
const validation = read("docs/alpha-20-validation.md");
const ci = read(".github/workflows/ci.yml");
const releaseWorkflow = read(".github/workflows/alpha-release.yml");
const windowsBuildWrapper = read("scripts/build-windows-alpha.js");
const windowsVerifier = read("scripts/verify-windows-alpha.ps1");
const evidenceReferenceValidator = read("scripts/validate-alpha-evidence-reference.js");
const evidenceCommentValidator = read("scripts/validate-alpha-evidence-comments.js");
const { ALPHA_VERSION, ALPHA_ARTIFACT_NAME, ALPHA_SCENARIOS, MANUAL_SCENARIO_IDS } = require("./alpha-release-contract.js");

assert.equal(pkg.version, ALPHA_VERSION, "alpha_readiness_version_mismatch");
assert.equal(manifest.version_name, ALPHA_VERSION, "alpha_readiness_manifest_version_mismatch");
assert.equal(ALPHA_SCENARIOS.length, 17, "alpha_readiness_scenario_count_mismatch");
assert.deepEqual(MANUAL_SCENARIO_IDS, ["A01", "A11"], "alpha_manual_gate_drift");

for (const script of [
  "test:release", "test:phase17", "test:phase18", "test:phase19", "test:phase20", "test:alpha",
  "desktop:pack", "desktop:dist:win", "extension:stage-alpha", "companion:register-host", "companion:unregister-host"
]) {
  assert.equal(typeof pkg.scripts?.[script], "string", `alpha_readiness_script_missing:${script}`);
}
assert.ok(pkg.scripts["test:alpha"].includes("test:phase20"), "alpha_gate_must_run_phase20");
assert.equal(pkg.scripts["desktop:dist:win"], "node scripts/build-windows-alpha.js", "alpha_windows_build_must_embed_identity");

const phase20Gate = String(pkg.scripts["test:phase20"] || "");
for (const requiredTest of [
  "tests/alpha-manual-evidence.test.js",
  "tests/alpha-evidence-comments.test.js",
  "tests/alpha-build-identity.test.js",
  "tests/desktop-runtime-evidence.test.js"
]) assert.ok(phase20Gate.includes(requiredTest), `alpha_phase20_required_test_not_gated:${requiredTest}`);

for (const scenario of ALPHA_SCENARIOS) {
  assert.ok(validation.includes(scenario.id), `alpha_validation_missing_id:${scenario.id}`);
  assert.ok(validation.includes(scenario.title), `alpha_validation_missing_title:${scenario.id}`);
  for (const evidence of scenario.evidence) {
    assert.ok(fs.existsSync(path.join(ROOT, evidence)), `alpha_evidence_missing:${scenario.id}:${evidence}`);
    assert.ok(phase20Gate.includes(evidence), `alpha_evidence_not_gated:${scenario.id}:${evidence}`);
  }
}

for (const marker of [
  "Desktop-first Alpha Validation",
  "A01 and A11 require real manual evidence",
  "GitHub issue-comment permalink",
  "Build commit",
  "WINDOWS_CSC_LINK",
  "Authenticode=Valid",
  "final `v2.0.0-alpha.20` prerelease"
]) assert.ok(validation.includes(marker), `alpha_validation_marker_missing:${marker}`);

for (const marker of [
  "desktop-alpha:",
  "npm run test:phase20",
  "alpha-package:",
  "runs-on: windows-latest",
  "ORCHESTRA_BUILD_COMMIT: ${{ github.sha }}",
  "npm run test:alpha",
  "npm run desktop:dist:win",
  "npm run extension:stage-alpha",
  "./scripts/verify-windows-alpha.ps1",
  "alpha-build-evidence.json",
  `name: ${ALPHA_ARTIFACT_NAME}`,
  "actions/upload-artifact@v4"
]) assert.ok(ci.includes(marker), `alpha_readiness_ci_marker_missing:${marker}`);

assert.ok(windowsBuildWrapper.includes("--publish"), "alpha_windows_build_publish_policy_missing");
assert.ok(windowsBuildWrapper.includes("never"), "alpha_windows_build_must_never_publish_implicitly");
assert.ok(windowsBuildWrapper.includes("alpha-build-evidence.json"), "alpha_build_identity_evidence_missing");
assert.ok(windowsVerifier.includes(ALPHA_VERSION), "alpha_windows_verifier_version_mismatch");
assert.ok(windowsVerifier.includes("alpha-build-evidence.json"), "alpha_build_verifier_missing");
assert.ok(windowsVerifier.includes("alpha-signature-evidence.json"), "alpha_signature_evidence_missing");
assert.ok(windowsVerifier.includes("alpha_build_evidence_commit_mismatch"), "alpha_build_commit_verification_missing");

for (const marker of [
  "workflow_dispatch:",
  "a01_evidence:",
  "a11_evidence:",
  "validate-alpha-evidence-reference.js",
  "validate-alpha-evidence-comments.js",
  "ALPHA_EXPECTED_COMMIT: ${{ github.sha }}",
  "ORCHESTRA_BUILD_COMMIT: ${{ github.sha }}",
  "WINDOWS_CSC_LINK",
  "WINDOWS_CSC_KEY_PASSWORD",
  "npm run test:alpha",
  "alpha-build-evidence.json",
  "verify-windows-alpha.ps1 -RequireSignature",
  "chatgpt-orchestra-alpha20-signed-windows"
]) assert.ok(releaseWorkflow.includes(marker), `alpha_release_workflow_marker_missing:${marker}`);
assert.ok(!releaseWorkflow.includes("PUBLISH_FOR_PULL_REQUEST"), "alpha_release_must_not_force_pr_secrets");

assert.ok(evidenceReferenceValidator.includes("issuecomment-"), "alpha_evidence_validator_must_require_comment_permalink");
assert.ok(evidenceReferenceValidator.includes("VadimAlekseyevich"), "alpha_evidence_validator_owner_drift");
assert.ok(evidenceReferenceValidator.includes("ChatGPT-Orchestra"), "alpha_evidence_validator_repo_drift");
assert.ok(evidenceCommentValidator.includes("Build commit"), "alpha_evidence_comment_build_commit_missing");
assert.ok(evidenceCommentValidator.includes("alpha_manual_evidence_build_commit_mismatch"), "alpha_evidence_comment_commit_match_gate_missing");

assert.ok(/needs:\s*\[[^\]]*desktop-alpha[^\]]*alpha-package[^\]]*\]/s.test(ci), "alpha_jobs_must_gate_aggregate");

console.log(`desktop alpha candidate readiness ok: ${ALPHA_VERSION}; automated scenarios=${ALPHA_SCENARIOS.length}; manual release evidence pending=${MANUAL_SCENARIO_IDS.join(",")}; signed release workflow=strict; build identity=commit-bound`);
