"use strict";

const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");

const ROOT = path.resolve(__dirname, "..");

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), "utf8");
}

const pkg = JSON.parse(read("package.json"));
const manifest = JSON.parse(read("manifest.json"));
const roadmap = read("ROADMAP.md");
const smoke = read("docs/alpha-16-smoke-test.md");
const ci = read(".github/workflows/ci.yml");

assert.equal(pkg.version, "2.0.0-alpha.16", "alpha_readiness_version_mismatch");
assert.equal(manifest.version_name, pkg.version, "alpha_readiness_manifest_version_mismatch");
for (const script of ["test:alpha", "desktop:pack", "extension:stage-alpha", "companion:register-host", "companion:unregister-host"]) {
  assert.equal(typeof pkg.scripts?.[script], "string", `alpha_readiness_script_missing:${script}`);
}

for (const marker of [
  "Alpha Gate before Phase 17",
  "Issue #26",
  "deferred until after alpha validation",
  "Do not start Phase 17"
]) assert.ok(roadmap.includes(marker), `alpha_readiness_roadmap_marker_missing:${marker}`);

for (const marker of [
  "2.0.0-alpha.16",
  "Migrate Project → Desktop",
  "--register-native-host=",
  "--companion",
  "fail-closed",
  "issue #26"
]) assert.ok(smoke.includes(marker), `alpha_readiness_smoke_marker_missing:${marker}`);

for (const marker of [
  "alpha-package:",
  "runs-on: windows-latest",
  "npm run test:alpha",
  "npm run desktop:pack",
  "npm run extension:stage-alpha",
  "actions/upload-artifact@v4",
  "chatgpt-orchestra-alpha16-windows"
]) assert.ok(ci.includes(marker), `alpha_readiness_ci_marker_missing:${marker}`);

assert.ok(/needs:\s*\[[^\]]*alpha-package[^\]]*\]/s.test(ci), "alpha_package_must_gate_aggregate");

console.log(`alpha readiness contract ok: ${pkg.version}`);
