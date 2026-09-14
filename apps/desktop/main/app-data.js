"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PROFILE_EVIDENCE_SCHEMA_VERSION = 1;

function resolveDesktopDataDirectory({ platform = process.platform, env = process.env, home = os.homedir(), appName = "ChatGPT Orchestra" } = {}) {
  if (platform === "win32") {
    const base = env.APPDATA || env.LOCALAPPDATA || path.join(home, "AppData", "Roaming");
    return path.join(base, appName);
  }
  if (platform === "darwin") return path.join(home, "Library", "Application Support", appName);
  const base = env.XDG_DATA_HOME || path.join(home, ".local", "share");
  return path.join(base, "chatgpt-orchestra");
}

function readDesktopProfileEvidence(input) {
  const filename = typeof input === "string" ? input : input?.profileMetadataFile;
  if (!filename) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(filename, "utf8"));
    if (Number(parsed?.schemaVersion) !== PROFILE_EVIDENCE_SCHEMA_VERSION) return null;
    const createdMs = Date.parse(String(parsed?.profileCreatedAtUtc || ""));
    if (!Number.isFinite(createdMs)) return null;
    return Object.freeze({
      schemaVersion: PROFILE_EVIDENCE_SCHEMA_VERSION,
      profileCreatedAtUtc: new Date(createdMs).toISOString()
    });
  } catch (_) {
    return null;
  }
}

function ensureDesktopProfileEvidence(filename, { clock = () => Date.now() } = {}) {
  const existing = readDesktopProfileEvidence(filename);
  if (existing) return existing;
  if (fs.existsSync(filename)) return null;

  const createdMs = Number(clock());
  if (!Number.isFinite(createdMs)) return null;
  const evidence = {
    schemaVersion: PROFILE_EVIDENCE_SCHEMA_VERSION,
    profileCreatedAtUtc: new Date(createdMs).toISOString()
  };
  try {
    fs.writeFileSync(filename, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error?.code !== "EEXIST") return null;
  }
  return readDesktopProfileEvidence(filename);
}

function ensureDesktopPaths({ dataDirectory = null, clock = () => Date.now(), ...options } = {}) {
  const root = path.resolve(dataDirectory || resolveDesktopDataDirectory(options));
  const paths = {
    root,
    stateDirectory: path.join(root, "state"),
    logsDirectory: path.join(root, "logs"),
    bundlesDirectory: path.join(root, "bundles"),
    companionDirectory: path.join(root, "companion"),
    repositoriesDirectory: path.join(root, "repositories"),
    workspacesDirectory: path.join(root, "workspaces"),
    browserProfileDirectory: path.join(root, "browser-profile"),
    stateDatabase: path.join(root, "state", "orchestra.sqlite"),
    logFile: path.join(root, "logs", "orchestra.jsonl"),
    profileMetadataFile: path.join(root, "profile-metadata.json"),
    companionSecretFile: path.join(root, "companion", "pairing-secret"),
    companionEndpointFile: path.join(root, "companion", "endpoint.json"),
    companionMigrationPendingFile: path.join(root, "companion", "migration-pending.json"),
    companionMigrationReceiptFile: path.join(root, "companion", "migration-applied.json"),
    companionNativeHostManifestFile: path.join(root, "companion", "native-host-manifest.json")
  };
  for (const directory of [
    paths.root,
    paths.stateDirectory,
    paths.logsDirectory,
    paths.bundlesDirectory,
    paths.companionDirectory,
    paths.repositoriesDirectory,
    paths.workspacesDirectory,
    paths.browserProfileDirectory
  ]) fs.mkdirSync(directory, { recursive: true });
  ensureDesktopProfileEvidence(paths.profileMetadataFile, { clock });
  return paths;
}

module.exports = {
  PROFILE_EVIDENCE_SCHEMA_VERSION,
  resolveDesktopDataDirectory,
  readDesktopProfileEvidence,
  ensureDesktopProfileEvidence,
  ensureDesktopPaths
};
