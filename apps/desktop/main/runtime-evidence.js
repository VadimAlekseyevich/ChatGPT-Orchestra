"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const { version: PACKAGE_VERSION } = require("../../../package.json");

const MINUTE_MS = 60 * 1000;
const BUILD_METADATA_PATH = path.resolve(__dirname, "..", "generated", "build-metadata.json");
const COMMIT_PATTERN = /^[a-f0-9]{40}$/i;

function finiteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizedCommit(value) {
  const commit = String(value || "").trim();
  return COMMIT_PATTERN.test(commit) ? commit.toLowerCase() : null;
}

function loadBuildMetadata({ filename = BUILD_METADATA_PATH } = {}) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filename, "utf8"));
    return Object.freeze({
      version: String(parsed?.version || PACKAGE_VERSION),
      commit: normalizedCommit(parsed?.commit)
    });
  } catch (_) {
    return Object.freeze({ version: PACKAGE_VERSION, commit: null });
  }
}

function createDesktopRuntimeEvidence({
  clock = () => Date.now(),
  uptime = () => os.uptime(),
  platform = process.platform,
  arch = process.arch,
  release = () => os.release(),
  buildMetadata = loadBuildMetadata()
} = {}) {
  const nowMs = finiteNumber(clock(), Date.now());
  const uptimeMs = Math.max(0, finiteNumber(uptime(), 0) * 1000);
  const bootMs = Math.max(0, nowMs - uptimeMs);
  const roundedBootMs = Math.floor(bootMs / MINUTE_MS) * MINUTE_MS;

  return Object.freeze({
    schemaVersion: 2,
    platform: String(platform || "unknown"),
    arch: String(arch || "unknown"),
    osRelease: String(typeof release === "function" ? release() : release || "unknown"),
    systemBootTimeUtc: new Date(roundedBootMs).toISOString(),
    buildVersion: String(buildMetadata?.version || PACKAGE_VERSION),
    buildCommit: normalizedCommit(buildMetadata?.commit)
  });
}

module.exports = {
  MINUTE_MS,
  BUILD_METADATA_PATH,
  normalizedCommit,
  loadBuildMetadata,
  createDesktopRuntimeEvidence
};
