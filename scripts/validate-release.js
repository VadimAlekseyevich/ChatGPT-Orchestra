"use strict";

const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");

const ROOT = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const Contracts = require(path.join(ROOT, "platform/contracts.js"));

function exists(relative) {
  assert.ok(fs.existsSync(path.join(ROOT, relative)), `missing_declared_file:${relative}`);
}

assert.equal(manifest.manifest_version, 3, "manifest_must_be_mv3");
assert.equal(manifest.version_name, pkg.version, "package_manifest_version_mismatch");
assert.ok(pkg.version.startsWith(`${manifest.version}-`), "numeric_manifest_version_must_prefix_prerelease");
assert.ok(/alpha\.15$/.test(pkg.version), "phase14_expected_alpha15");

const permissions = manifest.permissions || [];
assert.equal(new Set(permissions).size, permissions.length, "duplicate_manifest_permission");
for (const required of ["storage", "tabs", "alarms"]) assert.ok(permissions.includes(required), `missing_manifest_permission:${required}`);
for (const permission of permissions) assert.ok(["storage", "tabs", "alarms"].includes(permission), `unexpected_manifest_permission:${permission}`);

const hosts = manifest.host_permissions || [];
assert.equal(new Set(hosts).size, hosts.length, "duplicate_host_permission");
for (const required of ["https://chatgpt.com/*", "https://chat.openai.com/*", "https://api.github.com/*"]) assert.ok(hosts.includes(required), `missing_host_permission:${required}`);

exists(manifest.background?.service_worker || "");
for (const script of manifest.content_scripts?.flatMap((entry) => entry.js || []) || []) exists(script);

assert.ok(Contracts.CONTRACT_VERSION >= 4, "platform_contract_version_too_old");
for (const query of ["contextSummary", "contextPacket"]) assert.ok(Contracts.API_QUERIES.includes(query), `api_contract_drift:${query}`);
assert.ok(Array.isArray(Contracts.GIT_WORKSPACE_METHODS) && Contracts.GIT_WORKSPACE_METHODS.length > 0, "git_workspace_contract_missing");

for (const requiredScript of ["test", "test:contracts", "test:browser-fixtures", "test:release", "test:phase14"]) {
  assert.equal(typeof pkg.scripts?.[requiredScript], "string", `missing_package_script:${requiredScript}`);
}

exists(".github/workflows/ci.yml");
console.log(`release validation ok: ${pkg.version}, contract v${Contracts.CONTRACT_VERSION}`);
