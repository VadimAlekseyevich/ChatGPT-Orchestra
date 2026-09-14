"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  normalizedCommit,
  resolveBuildCommit
} = require("../scripts/build-windows-alpha.js");
const {
  loadBuildMetadata,
  createDesktopRuntimeEvidence
} = require("../apps/desktop/main/runtime-evidence.js");

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

test("Windows alpha build identity accepts only exact 40-hex source commits", () => {
  assert.equal(normalizedCommit(COMMIT.toUpperCase()), COMMIT);
  assert.equal(normalizedCommit("deadbeef"), null);
  assert.equal(normalizedCommit(`${COMMIT}00`), null);
  assert.equal(normalizedCommit("z".repeat(40)), null);
});

test("build commit resolution prefers explicit release identity then GitHub SHA then git HEAD", () => {
  assert.equal(resolveBuildCommit({
    env: { ORCHESTRA_BUILD_COMMIT: COMMIT, GITHUB_SHA: "f".repeat(40) },
    spawn() { throw new Error("git_should_not_run"); }
  }), COMMIT);

  assert.equal(resolveBuildCommit({
    env: { GITHUB_SHA: "a".repeat(40) },
    spawn() { throw new Error("git_should_not_run"); }
  }), "a".repeat(40));

  assert.equal(resolveBuildCommit({
    env: {},
    spawn(command, args) {
      assert.equal(command, "git");
      assert.deepEqual(args, ["rev-parse", "HEAD"]);
      return { status: 0, stdout: `${COMMIT}\n` };
    }
  }), COMMIT);
});

test("packaged runtime evidence carries the exact build version and commit without host secrets", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-build-id-"));
  const filename = path.join(dir, "build-metadata.json");
  fs.writeFileSync(filename, `${JSON.stringify({ schemaVersion: 1, version: "2.0.0-alpha.20", commit: COMMIT })}\n`, "utf8");

  try {
    const metadata = loadBuildMetadata({ filename });
    assert.deepEqual(metadata, { version: "2.0.0-alpha.20", commit: COMMIT });

    const evidence = createDesktopRuntimeEvidence({
      clock: () => Date.parse("2026-09-15T03:00:00.000Z"),
      uptime: () => 60,
      platform: "win32",
      arch: "x64",
      release: () => "10.0.26100",
      buildMetadata: metadata
    });
    assert.equal(evidence.schemaVersion, 2);
    assert.equal(evidence.buildVersion, "2.0.0-alpha.20");
    assert.equal(evidence.buildCommit, COMMIT);
    assert.deepEqual(Object.keys(evidence).sort(), [
      "arch",
      "buildCommit",
      "buildVersion",
      "osRelease",
      "platform",
      "schemaVersion",
      "systemBootTimeUtc"
    ].sort());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("development runtime evidence fails closed to null commit when build metadata is absent", () => {
  const metadata = loadBuildMetadata({ filename: path.join(os.tmpdir(), `missing-${Date.now()}.json`) });
  assert.equal(metadata.commit, null);
  assert.equal(metadata.version, "2.0.0-alpha.20");
});
