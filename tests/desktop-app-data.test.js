const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  resolveDesktopDataDirectory,
  readDesktopProfileEvidence,
  ensureDesktopPaths
} = require("../apps/desktop/main/app-data.js");

test("desktop app data resolution is platform-specific and deterministic", () => {
  assert.equal(resolveDesktopDataDirectory({ platform: "win32", env: { APPDATA: "C:\\Users\\u\\AppData\\Roaming" }, home: "C:\\Users\\u" }), path.join("C:\\Users\\u\\AppData\\Roaming", "ChatGPT Orchestra"));
  assert.equal(resolveDesktopDataDirectory({ platform: "darwin", env: {}, home: "/Users/u" }), path.join("/Users/u", "Library", "Application Support", "ChatGPT Orchestra"));
  assert.equal(resolveDesktopDataDirectory({ platform: "linux", env: { XDG_DATA_HOME: "/data/u" }, home: "/home/u" }), path.join("/data/u", "chatgpt-orchestra"));
});

test("ensureDesktopPaths creates isolated state, logs, bundles, companion, repository, workspace and browser-profile directories", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-desktop-paths-"));
  const paths = ensureDesktopPaths({ dataDirectory: path.join(root, "app"), clock: () => Date.parse("2026-09-15T03:00:00Z") });
  for (const directory of [
    paths.root,
    paths.stateDirectory,
    paths.logsDirectory,
    paths.bundlesDirectory,
    paths.companionDirectory,
    paths.repositoriesDirectory,
    paths.workspacesDirectory,
    paths.browserProfileDirectory
  ]) {
    assert.equal(fs.statSync(directory).isDirectory(), true);
  }
  assert.equal(paths.stateDatabase, path.join(paths.stateDirectory, "orchestra.sqlite"));
  assert.equal(paths.logFile, path.join(paths.logsDirectory, "orchestra.jsonl"));
  assert.equal(paths.repositoriesDirectory, path.join(paths.root, "repositories"));
  assert.equal(paths.workspacesDirectory, path.join(paths.root, "workspaces"));
  assert.equal(paths.browserProfileDirectory, path.join(paths.root, "browser-profile"));
  assert.equal(paths.profileMetadataFile, path.join(paths.root, "profile-metadata.json"));
  assert.equal(paths.companionSecretFile, path.join(paths.companionDirectory, "pairing-secret"));
  assert.equal(paths.companionEndpointFile, path.join(paths.companionDirectory, "endpoint.json"));
  assert.equal(paths.companionMigrationPendingFile, path.join(paths.companionDirectory, "migration-pending.json"));
  assert.equal(paths.companionMigrationReceiptFile, path.join(paths.companionDirectory, "migration-applied.json"));
  assert.equal(paths.companionNativeHostManifestFile, path.join(paths.companionDirectory, "native-host-manifest.json"));
  assert.deepEqual(readDesktopProfileEvidence(paths), {
    schemaVersion: 1,
    profileCreatedAtUtc: "2026-09-15T03:00:00.000Z"
  });
});

test("fresh-profile evidence is created once and never refreshed by later app launches", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-profile-evidence-"));
  const dataDirectory = path.join(root, "app");
  const first = ensureDesktopPaths({ dataDirectory, clock: () => Date.parse("2026-09-15T03:00:00Z") });
  const second = ensureDesktopPaths({ dataDirectory, clock: () => Date.parse("2026-09-16T03:00:00Z") });

  assert.deepEqual(readDesktopProfileEvidence(first), {
    schemaVersion: 1,
    profileCreatedAtUtc: "2026-09-15T03:00:00.000Z"
  });
  assert.deepEqual(readDesktopProfileEvidence(second), readDesktopProfileEvidence(first));
});

test("corrupt existing profile evidence fails closed instead of minting a fresh timestamp", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-profile-corrupt-"));
  const dataDirectory = path.join(root, "app");
  fs.mkdirSync(dataDirectory, { recursive: true });
  fs.writeFileSync(path.join(dataDirectory, "profile-metadata.json"), "{not-json", "utf8");

  const paths = ensureDesktopPaths({ dataDirectory, clock: () => Date.parse("2026-09-15T03:00:00Z") });
  assert.equal(readDesktopProfileEvidence(paths), null);
  assert.equal(fs.readFileSync(paths.profileMetadataFile, "utf8"), "{not-json");
});
