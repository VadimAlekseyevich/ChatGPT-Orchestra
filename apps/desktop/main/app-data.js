"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function resolveDesktopDataDirectory({ platform = process.platform, env = process.env, home = os.homedir(), appName = "ChatGPT Orchestra" } = {}) {
  if (platform === "win32") {
    const base = env.APPDATA || env.LOCALAPPDATA || path.join(home, "AppData", "Roaming");
    return path.join(base, appName);
  }
  if (platform === "darwin") return path.join(home, "Library", "Application Support", appName);
  const base = env.XDG_DATA_HOME || path.join(home, ".local", "share");
  return path.join(base, "chatgpt-orchestra");
}

function ensureDesktopPaths({ dataDirectory = null, ...options } = {}) {
  const root = path.resolve(dataDirectory || resolveDesktopDataDirectory(options));
  const paths = {
    root,
    stateDirectory: path.join(root, "state"),
    logsDirectory: path.join(root, "logs"),
    bundlesDirectory: path.join(root, "bundles"),
    companionDirectory: path.join(root, "companion"),
    repositoriesDirectory: path.join(root, "repositories"),
    workspacesDirectory: path.join(root, "workspaces"),
    stateDatabase: path.join(root, "state", "orchestra.sqlite"),
    logFile: path.join(root, "logs", "orchestra.jsonl"),
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
    paths.workspacesDirectory
  ]) fs.mkdirSync(directory, { recursive: true });
  return paths;
}

module.exports = { resolveDesktopDataDirectory, ensureDesktopPaths };
