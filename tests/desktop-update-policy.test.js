"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const policy = fs.readFileSync(path.join(ROOT, "docs", "desktop-update-policy.md"), "utf8");
const releaseWorkflow = fs.readFileSync(path.join(ROOT, ".github", "workflows", "alpha-release.yml"), "utf8");

function collectTextFiles(root) {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...collectTextFiles(absolute));
    else if (/\.(?:js|cjs|mjs|json|html)$/i.test(entry.name)) files.push(absolute);
  }
  return files;
}

test("desktop alpha ships without an automatic updater or mutable update feed", () => {
  const dependencies = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  assert.equal(dependencies["electron-updater"], undefined, "electron-updater must remain absent during alpha");

  const desktopFiles = collectTextFiles(path.join(ROOT, "apps", "desktop"));
  const forbidden = [
    /\bautoUpdater\b/,
    /\belectron-updater\b/,
    /\bsetFeedURL\b/,
    /\bcheckForUpdates(?:AndNotify)?\b/,
    /update\.electronjs\.org/i
  ];

  for (const filename of desktopFiles) {
    const source = fs.readFileSync(filename, "utf8");
    for (const pattern of forbidden) {
      assert.doesNotMatch(source, pattern, `automatic updater surface found in ${path.relative(ROOT, filename)}`);
    }
  }
});

test("secure alpha update policy is signed-release-only and explicitly manual", () => {
  for (const marker of [
    "manual, signed-only update strategy",
    "does not include an automatic updater",
    "No auto-update is safer than an unsigned or weakly authenticated auto-update path",
    "Only a published prerelease created by the strict signed-release workflow",
    "Automatic updating is explicitly post-alpha work",
    "untrusted or unsigned payload is rejected fail-closed"
  ]) assert.ok(policy.includes(marker), `desktop_update_policy_marker_missing:${marker}`);
});

test("manual update source is still protected by the strict signed prerelease workflow", () => {
  for (const marker of [
    "verify-windows-alpha.ps1 -RequireSignature",
    "alpha-release-manifest.json",
    "SHA256SUMS.txt",
    "gh release create $tag",
    "--prerelease",
    "Verify published prerelease tag and assets"
  ]) assert.ok(releaseWorkflow.includes(marker), `desktop_update_release_gate_missing:${marker}`);
});
