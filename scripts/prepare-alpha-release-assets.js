"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ALPHA_VERSION = "2.0.0-alpha.20";
const ALPHA_TAG = "v2.0.0-alpha.20";
const COMMIT_PATTERN = /^[a-f0-9]{40}$/i;

function readJson(filename) {
  return JSON.parse(fs.readFileSync(filename, "utf8"));
}

function normalizeCommit(value) {
  const commit = String(value || "").trim();
  return COMMIT_PATTERN.test(commit) ? commit.toLowerCase() : null;
}

function sha256File(filename) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filename));
  return hash.digest("hex");
}

function fail(reason) {
  throw new Error(reason);
}

function verifyReleaseEvidence({ build, signature, manual, expectedCommit }) {
  const commit = normalizeCommit(expectedCommit);
  if (!commit) fail("alpha_release_expected_commit_invalid");

  for (const [name, value] of [["build", build], ["signature", signature], ["manual", manual]]) {
    if (String(value?.version || value?.alphaVersion || "") !== ALPHA_VERSION) fail(`alpha_release_${name}_version_mismatch`);
  }

  const buildCommit = normalizeCommit(build?.commit);
  const signatureCommit = normalizeCommit(signature?.buildCommit);
  const manualCommit = normalizeCommit(manual?.commit);
  const validationCommit = normalizeCommit(manual?.validation?.expectedCommit);
  for (const [name, value] of [
    ["build", buildCommit],
    ["signature", signatureCommit],
    ["manual", manualCommit],
    ["manual_validation", validationCommit]
  ]) {
    if (!value) fail(`alpha_release_${name}_commit_invalid`);
    if (value !== commit) fail(`alpha_release_${name}_commit_mismatch`);
  }

  if (signature?.requireSignature !== true) fail("alpha_release_signature_evidence_not_strict");
  const signatures = Array.isArray(signature?.signatures) ? signature.signatures : [];
  if (signatures.length < 2) fail("alpha_release_signature_evidence_incomplete");
  for (const item of signatures) {
    if (String(item?.status || "") !== "Valid") fail(`alpha_release_signature_not_valid:${item?.file || "unknown"}`);
    if (!String(item?.signerSubject || "").trim()) fail(`alpha_release_signer_missing:${item?.file || "unknown"}`);
  }

  const scenarios = Array.isArray(manual?.validation?.scenarios) ? manual.validation.scenarios : [];
  const ids = scenarios.map((item) => String(item?.scenarioId || "").toUpperCase()).sort();
  if (ids.join(",") !== "A01,A11") fail("alpha_release_manual_scenarios_incomplete");
  for (const item of scenarios) {
    if (normalizeCommit(item?.evidence?.buildCommit) !== commit) fail(`alpha_release_manual_scenario_commit_mismatch:${item?.scenarioId || "unknown"}`);
  }

  return { commit, signatures, scenarios };
}

function findInstaller(desktopDir) {
  const candidates = fs.readdirSync(desktopDir)
    .filter((name) => /^ChatGPT Orchestra Setup .*\.exe$/i.test(name))
    .sort();
  if (candidates.length !== 1) fail(`alpha_release_installer_count_invalid:${candidates.length}`);
  return path.join(desktopDir, candidates[0]);
}

function prepareReleaseAssets({
  desktopDir = path.resolve("dist", "desktop"),
  extensionZip = path.resolve("dist", "desktop", "chatgpt-orchestra-alpha20-extension.zip"),
  expectedCommit = process.env.ALPHA_EXPECTED_COMMIT || process.env.GITHUB_SHA,
  outputDir = desktopDir
} = {}) {
  const buildPath = path.join(desktopDir, "alpha-build-evidence.json");
  const signaturePath = path.join(desktopDir, "alpha-signature-evidence.json");
  const manualPath = path.join(desktopDir, "alpha-manual-evidence.json");
  for (const filename of [buildPath, signaturePath, manualPath, extensionZip]) {
    if (!fs.existsSync(filename)) fail(`alpha_release_asset_missing:${path.basename(filename)}`);
  }

  const build = readJson(buildPath);
  const signature = readJson(signaturePath);
  const manual = readJson(manualPath);
  const verified = verifyReleaseEvidence({ build, signature, manual, expectedCommit });
  const installer = findInstaller(desktopDir);

  const assets = [installer, extensionZip, buildPath, signaturePath, manualPath].map((filename) => ({
    filename,
    name: path.basename(filename),
    size: fs.statSync(filename).size,
    sha256: sha256File(filename)
  }));

  const manifest = {
    schemaVersion: 1,
    version: ALPHA_VERSION,
    tag: ALPHA_TAG,
    commit: verified.commit,
    installer: path.basename(installer),
    signerSubjects: [...new Set(verified.signatures.map((item) => String(item.signerSubject)))],
    manualEvidence: verified.scenarios.map((item) => ({
      scenarioId: item.scenarioId,
      reference: item.reference,
      bodySha256: item.bodySha256
    })),
    assets: assets.map(({ name, size, sha256 }) => ({ name, size, sha256 }))
  };

  fs.mkdirSync(outputDir, { recursive: true });
  const manifestPath = path.join(outputDir, "alpha-release-manifest.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const manifestAsset = {
    filename: manifestPath,
    name: path.basename(manifestPath),
    size: fs.statSync(manifestPath).size,
    sha256: sha256File(manifestPath)
  };
  assets.push(manifestAsset);

  const checksumsPath = path.join(outputDir, "SHA256SUMS.txt");
  fs.writeFileSync(checksumsPath, `${assets.map((item) => `${item.sha256}  ${item.name}`).join("\n")}\n`, "utf8");
  assets.push({
    filename: checksumsPath,
    name: path.basename(checksumsPath),
    size: fs.statSync(checksumsPath).size,
    sha256: sha256File(checksumsPath)
  });

  const notesPath = path.join(outputDir, "alpha-release-notes.md");
  const notes = [
    `# ChatGPT Orchestra ${ALPHA_VERSION}`,
    "",
    "Desktop-first alpha for Windows.",
    "",
    `Source commit: \`${verified.commit}\``,
    "",
    "Release gates passed before publication:",
    "- automated Phase 20 acceptance contract (A01–A17);",
    "- real A01 fresh-install / interactive ChatGPT login evidence;",
    "- real A11 OS-restart / project-resume evidence;",
    "- exact build-commit binding across candidate, manual evidence and signed artifact;",
    "- Authenticode=Valid for both the unpacked desktop executable and NSIS installer.",
    "",
    "`SHA256SUMS.txt` and the JSON evidence manifests are attached for auditability.",
    ""
  ].join("\n");
  fs.writeFileSync(notesPath, notes, "utf8");
  assets.push({
    filename: notesPath,
    name: path.basename(notesPath),
    size: fs.statSync(notesPath).size,
    sha256: sha256File(notesPath)
  });

  return { manifest, manifestPath, checksumsPath, notesPath, assets };
}

function main() {
  const result = prepareReleaseAssets();
  console.log(`alpha release assets ready: tag=${result.manifest.tag}; commit=${result.manifest.commit}; assets=${result.assets.length}`);
}

if (require.main === module) {
  try { main(); } catch (error) {
    console.error(String(error?.message || error));
    process.exitCode = 1;
  }
}

module.exports = {
  ALPHA_VERSION,
  ALPHA_TAG,
  normalizeCommit,
  sha256File,
  verifyReleaseEvidence,
  findInstaller,
  prepareReleaseAssets
};
