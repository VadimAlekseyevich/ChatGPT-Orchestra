const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { resolveDesktopDataDirectory, ensureDesktopPaths } = require("../apps/desktop/main/app-data.js");

test("desktop app data resolution is platform-specific and deterministic", () => {
  assert.equal(resolveDesktopDataDirectory({ platform: "win32", env: { APPDATA: "C:\\Users\\u\\AppData\\Roaming" }, home: "C:\\Users\\u" }), path.join("C:\\Users\\u\\AppData\\Roaming", "ChatGPT Orchestra"));
  assert.equal(resolveDesktopDataDirectory({ platform: "darwin", env: {}, home: "/Users/u" }), path.join("/Users/u", "Library", "Application Support", "ChatGPT Orchestra"));
  assert.equal(resolveDesktopDataDirectory({ platform: "linux", env: { XDG_DATA_HOME: "/data/u" }, home: "/home/u" }), path.join("/data/u", "chatgpt-orchestra"));
});

test("ensureDesktopPaths creates isolated state, logs, bundles and companion directories", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-desktop-paths-"));
  const paths = ensureDesktopPaths({ dataDirectory: path.join(root, "app") });
  for (const directory of [paths.root, paths.stateDirectory, paths.logsDirectory, paths.bundlesDirectory, paths.companionDirectory]) {
    assert.equal(fs.statSync(directory).isDirectory(), true);
  }
  assert.equal(paths.stateDatabase, path.join(paths.stateDirectory, "orchestra.sqlite"));
  assert.equal(paths.logFile, path.join(paths.logsDirectory, "orchestra.jsonl"));
  assert.equal(paths.companionSecretFile, path.join(paths.companionDirectory, "pairing-secret"));
  assert.equal(paths.companionEndpointFile, path.join(paths.companionDirectory, "endpoint.json"));
});
