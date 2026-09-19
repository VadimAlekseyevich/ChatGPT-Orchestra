"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { main: stageAlphaExtension } = require("./stage-alpha-extension.js");

const ROOT = path.resolve(__dirname, "..");
const PACKAGE_PATH = path.join(ROOT, "package.json");
const GENERATED_DIR = path.join(ROOT, "apps", "desktop", "generated");
const BUILD_METADATA_PATH = path.join(GENERATED_DIR, "build-metadata.json");
const BUILD_EVIDENCE_PATH = path.join(ROOT, "dist", "desktop", "alpha-build-evidence.json");
const COMMIT_PATTERN = /^[a-f0-9]{40}$/i;

function normalizedCommit(value) {
  const commit = String(value || "").trim();
  return COMMIT_PATTERN.test(commit) ? commit.toLowerCase() : null;
}

function resolveBuildCommit({ env = process.env, spawn = spawnSync } = {}) {
  for (const candidate of [env.ORCHESTRA_BUILD_COMMIT, env.GITHUB_SHA]) {
    const commit = normalizedCommit(candidate);
    if (commit) return commit;
  }

  const result = spawn("git", ["rev-parse", "HEAD"], {
    cwd: ROOT,
    encoding: "utf8",
    windowsHide: true
  });
  if (result.status !== 0) throw new Error("alpha_build_commit_unavailable");
  const commit = normalizedCommit(result.stdout);
  if (!commit) throw new Error("alpha_build_commit_invalid");
  return commit;
}

function electronBuilderCli() {
  const packagePath = require.resolve("electron-builder/package.json", { paths: [ROOT] });
  const electronBuilderPackage = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  const bin = typeof electronBuilderPackage.bin === "string"
    ? electronBuilderPackage.bin
    : electronBuilderPackage.bin?.["electron-builder"];
  if (!bin) throw new Error("electron_builder_cli_missing");
  return path.resolve(path.dirname(packagePath), bin);
}

function buildIdentity({ commit, version }) {
  const normalized = normalizedCommit(commit);
  if (!normalized) throw new Error("alpha_build_commit_invalid");
  return Object.freeze({ schemaVersion: 1, version: String(version || ""), commit: normalized });
}

function writeJson(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeBuildMetadata(identity) {
  writeJson(BUILD_METADATA_PATH, identity);
}

function writeBuildEvidence(identity) {
  writeJson(BUILD_EVIDENCE_PATH, identity);
}

function removeGeneratedBuildMetadata() {
  fs.rmSync(BUILD_METADATA_PATH, { force: true });
  try { fs.rmdirSync(GENERATED_DIR); } catch (_) {}
}

function main() {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, "utf8"));
  const identity = buildIdentity({ commit: resolveBuildCommit(), version: pkg.version });
  writeBuildMetadata(identity);
  console.log(`Windows alpha build identity: version=${identity.version} commit=${identity.commit}`);
  stageAlphaExtension();

  try {
    const result = spawnSync(process.execPath, [electronBuilderCli(), "--win", "nsis", "--publish", "never"], {
      cwd: ROOT,
      stdio: "inherit",
      env: process.env,
      windowsHide: false
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      process.exitCode = Number.isInteger(result.status) ? result.status : 1;
      return;
    }
    writeBuildEvidence(identity);
    console.log(`Windows alpha build evidence: ${path.relative(ROOT, BUILD_EVIDENCE_PATH)}`);
  } finally {
    removeGeneratedBuildMetadata();
  }
}

if (require.main === module) main();

module.exports = {
  ROOT,
  BUILD_METADATA_PATH,
  BUILD_EVIDENCE_PATH,
  normalizedCommit,
  resolveBuildCommit,
  buildIdentity,
  writeBuildMetadata,
  writeBuildEvidence,
  removeGeneratedBuildMetadata,
  electronBuilderCli
};
