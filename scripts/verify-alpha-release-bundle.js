"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  ALPHA_VERSION,
  ALPHA_TAG,
  normalizeCommit,
  normalizeWorkflowRun,
  sha256File,
  verifyReleaseEvidence,
  findInstaller
} = require("./prepare-alpha-release-assets.js");

function fail(reason) {
  throw new Error(reason);
}

function readJson(filename) {
  return JSON.parse(fs.readFileSync(filename, "utf8"));
}

function parseChecksums(text) {
  const entries = new Map();
  for (const raw of String(text || "").split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const match = /^([a-f0-9]{64})  ([^/\\]+)$/i.exec(raw);
    if (!match) fail("alpha_release_checksum_line_invalid");
    const name = match[2];
    if (path.basename(name) !== name || name === "." || name === "..") fail(`alpha_release_checksum_name_invalid:${name}`);
    if (entries.has(name)) fail(`alpha_release_checksum_duplicate:${name}`);
    entries.set(name, match[1].toLowerCase());
  }
  if (entries.size === 0) fail("alpha_release_checksums_empty");
  return entries;
}

function sameStringSet(left, right) {
  return [...new Set(left.map(String))].sort().join("\n") === [...new Set(right.map(String))].sort().join("\n");
}

function verifyReleaseBundle({
  desktopDir = path.resolve("dist", "desktop"),
  expectedCommit = process.env.ALPHA_EXPECTED_COMMIT || process.env.GITHUB_SHA,
  expectedWorkflowRun = process.env.GITHUB_RUN_ID || null
} = {}) {
  const commit = normalizeCommit(expectedCommit);
  if (!commit) fail("alpha_release_expected_commit_invalid");
  const workflowRun = expectedWorkflowRun == null ? null : normalizeWorkflowRun(expectedWorkflowRun);
  if (expectedWorkflowRun != null && !workflowRun) fail("alpha_release_expected_workflow_run_invalid");

  const paths = {
    build: path.join(desktopDir, "alpha-build-evidence.json"),
    signature: path.join(desktopDir, "alpha-signature-evidence.json"),
    manual: path.join(desktopDir, "alpha-manual-evidence.json"),
    manifest: path.join(desktopDir, "alpha-release-manifest.json"),
    checksums: path.join(desktopDir, "SHA256SUMS.txt"),
    notes: path.join(desktopDir, "alpha-release-notes.md"),
    extension: path.join(desktopDir, "chatgpt-orchestra-alpha20-extension.zip")
  };
  for (const [name, filename] of Object.entries(paths)) {
    if (!fs.existsSync(filename) || !fs.statSync(filename).isFile()) fail(`alpha_release_bundle_missing:${name}`);
  }

  const build = readJson(paths.build);
  const signature = readJson(paths.signature);
  const manual = readJson(paths.manual);
  const verified = verifyReleaseEvidence({ build, signature, manual, expectedCommit: commit, expectedWorkflowRun: workflowRun });
  const installer = findInstaller(desktopDir);
  const installerName = path.basename(installer);

  const manifest = readJson(paths.manifest);
  if (manifest?.schemaVersion !== 1) fail("alpha_release_manifest_schema_invalid");
  if (String(manifest?.version || "") !== ALPHA_VERSION) fail("alpha_release_manifest_version_mismatch");
  if (String(manifest?.tag || "") !== ALPHA_TAG) fail("alpha_release_manifest_tag_mismatch");
  if (normalizeCommit(manifest?.commit) !== commit) fail("alpha_release_manifest_commit_mismatch");
  if (normalizeWorkflowRun(manifest?.workflowRun) !== verified.workflowRun) fail("alpha_release_manifest_workflow_run_mismatch");
  if (String(manifest?.installer || "") !== installerName) fail("alpha_release_manifest_installer_mismatch");

  const expectedSigners = verified.signatures.map((item) => String(item.signerSubject));
  const manifestSigners = Array.isArray(manifest?.signerSubjects) ? manifest.signerSubjects.map(String) : [];
  if (!sameStringSet(manifestSigners, expectedSigners)) fail("alpha_release_manifest_signers_mismatch");

  const expectedManual = verified.scenarios
    .map((item) => ({ scenarioId: String(item.scenarioId), reference: String(item.reference || ""), bodySha256: String(item.bodySha256 || "") }))
    .sort((a, b) => a.scenarioId.localeCompare(b.scenarioId));
  const manifestManual = (Array.isArray(manifest?.manualEvidence) ? manifest.manualEvidence : [])
    .map((item) => ({ scenarioId: String(item?.scenarioId || ""), reference: String(item?.reference || ""), bodySha256: String(item?.bodySha256 || "") }))
    .sort((a, b) => a.scenarioId.localeCompare(b.scenarioId));
  if (JSON.stringify(manifestManual) !== JSON.stringify(expectedManual)) fail("alpha_release_manifest_manual_evidence_mismatch");

  const expectedAssetNames = [
    installerName,
    path.basename(paths.extension),
    path.basename(paths.build),
    path.basename(paths.signature),
    path.basename(paths.manual)
  ].sort();
  const manifestAssets = Array.isArray(manifest?.assets) ? manifest.assets : [];
  const manifestAssetNames = manifestAssets.map((item) => String(item?.name || "")).sort();
  if (manifestAssetNames.join("\n") !== expectedAssetNames.join("\n")) fail("alpha_release_manifest_assets_mismatch");

  for (const item of manifestAssets) {
    const name = String(item?.name || "");
    if (!name || path.basename(name) !== name) fail(`alpha_release_manifest_asset_name_invalid:${name}`);
    const filename = path.join(desktopDir, name);
    if (!fs.existsSync(filename) || !fs.statSync(filename).isFile()) fail(`alpha_release_manifest_asset_missing:${name}`);
    const size = fs.statSync(filename).size;
    if (Number(item?.size) !== size) fail(`alpha_release_manifest_asset_size_mismatch:${name}`);
    if (String(item?.sha256 || "").toLowerCase() !== sha256File(filename)) fail(`alpha_release_manifest_asset_hash_mismatch:${name}`);
  }

  const checksums = parseChecksums(fs.readFileSync(paths.checksums, "utf8"));
  const checksumNames = [...expectedAssetNames, path.basename(paths.manifest)].sort();
  if ([...checksums.keys()].sort().join("\n") !== checksumNames.join("\n")) fail("alpha_release_checksum_assets_mismatch");
  for (const [name, expectedHash] of checksums) {
    const filename = path.join(desktopDir, name);
    if (!fs.existsSync(filename) || !fs.statSync(filename).isFile()) fail(`alpha_release_checksum_asset_missing:${name}`);
    if (sha256File(filename) !== expectedHash) fail(`alpha_release_checksum_mismatch:${name}`);
  }

  const notes = fs.readFileSync(paths.notes, "utf8");
  if (
    !notes.includes(ALPHA_VERSION) ||
    !notes.includes(commit) ||
    !notes.includes(`Workflow run: ${verified.workflowRun}`) ||
    !notes.includes("Authenticode=Valid")
  ) {
    fail("alpha_release_notes_identity_mismatch");
  }

  return {
    version: ALPHA_VERSION,
    tag: ALPHA_TAG,
    commit,
    workflowRun: verified.workflowRun,
    installer: installerName,
    assetNames: checksumNames
  };
}

function main() {
  const result = verifyReleaseBundle();
  console.log(`alpha release bundle verified: tag=${result.tag}; commit=${result.commit}; workflowRun=${result.workflowRun}; assets=${result.assetNames.length}`);
}

if (require.main === module) {
  try { main(); } catch (error) {
    console.error(String(error?.message || error));
    process.exitCode = 1;
  }
}

module.exports = { parseChecksums, verifyReleaseBundle };
