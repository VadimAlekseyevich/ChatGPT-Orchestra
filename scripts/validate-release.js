"use strict";

const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");

const ROOT = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const Contracts = require(path.join(ROOT, "platform/contracts.js"));
const { ALPHA_VERSION, ALPHA_SCENARIOS } = require(path.join(ROOT, "scripts/alpha-release-contract.js"));

function exists(relative) {
  assert.ok(fs.existsSync(path.join(ROOT, relative)), `missing_declared_file:${relative}`);
}

assert.equal(pkg.version, ALPHA_VERSION, "alpha_release_version_mismatch");
assert.equal(manifest.manifest_version, 3, "manifest_must_be_mv3");
assert.equal(manifest.version_name, pkg.version, "package_manifest_version_mismatch");
assert.ok(pkg.version.startsWith(`${manifest.version}-`), "numeric_manifest_version_must_prefix_prerelease");
assert.ok(/alpha\.20$/.test(pkg.version), "alpha_release_expected_alpha20");
assert.equal(ALPHA_SCENARIOS.length, 17, "phase20_release_scenario_count_mismatch");

const permissions = manifest.permissions || [];
assert.equal(new Set(permissions).size, permissions.length, "duplicate_manifest_permission");
for (const required of ["storage", "tabs", "alarms", "nativeMessaging"]) assert.ok(permissions.includes(required), `missing_manifest_permission:${required}`);
for (const permission of permissions) assert.ok(["storage", "tabs", "alarms", "nativeMessaging"].includes(permission), `unexpected_manifest_permission:${permission}`);

const hosts = manifest.host_permissions || [];
assert.equal(new Set(hosts).size, hosts.length, "duplicate_host_permission");
for (const required of ["https://chatgpt.com/*", "https://chat.openai.com/*", "https://api.github.com/*"]) assert.ok(hosts.includes(required), `missing_host_permission:${required}`);

exists(manifest.background?.service_worker || "");
for (const script of manifest.content_scripts?.flatMap((entry) => entry.js || []) || []) exists(script);

assert.ok(Contracts.CONTRACT_VERSION >= 4, "platform_contract_version_too_old");
for (const query of ["contextSummary", "contextPacket"]) assert.ok(Contracts.API_QUERIES.includes(query), `api_contract_drift:${query}`);
assert.ok(Array.isArray(Contracts.GIT_WORKSPACE_METHODS) && Contracts.GIT_WORKSPACE_METHODS.length > 0, "git_workspace_contract_missing");

for (const requiredScript of [
  "test", "test:contracts", "test:browser-fixtures", "test:release", "test:phase14",
  "test:phase15", "test:phase16", "test:phase17", "test:phase18", "test:phase19", "test:phase20", "test:alpha",
  "desktop:pack", "desktop:dist:win", "extension:stage-alpha"
]) {
  assert.equal(typeof pkg.scripts?.[requiredScript], "string", `missing_package_script:${requiredScript}`);
}

exists(".github/workflows/ci.yml");
exists("docs/alpha-20-validation.md");
exists("scripts/alpha-release-contract.js");
exists("tests/phase20-alpha-scenarios.test.js");
console.log(`release validation ok: ${pkg.version}, contract v${Contracts.CONTRACT_VERSION}, scenarios ${ALPHA_SCENARIOS.length}`);
