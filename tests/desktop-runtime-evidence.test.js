"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  MINUTE_MS,
  createDesktopRuntimeEvidence
} = require("../apps/desktop/main/runtime-evidence.js");

const PLATFORM = "win32";
const ARCH = "x64";
const RELEASE = "10.0.26100";
const BUILD_VERSION = "2.0.0-alpha.20";
const BUILD_COMMIT = "0123456789abcdef0123456789abcdef01234567";

function evidence(clockMs, uptimeSeconds) {
  return createDesktopRuntimeEvidence({
    clock: () => clockMs,
    uptime: () => uptimeSeconds,
    platform: PLATFORM,
    arch: ARCH,
    release: () => RELEASE,
    buildMetadata: { version: BUILD_VERSION, commit: BUILD_COMMIT }
  });
}

test("desktop runtime evidence reports only non-secret host, boot and immutable build metadata", () => {
  const now = Date.parse("2026-09-15T01:00:30.000Z");
  const value = evidence(now, 3630);

  assert.deepEqual(value, {
    schemaVersion: 2,
    platform: PLATFORM,
    arch: ARCH,
    osRelease: RELEASE,
    systemBootTimeUtc: "2026-09-15T00:00:00.000Z",
    buildVersion: BUILD_VERSION,
    buildCommit: BUILD_COMMIT
  });
  assert.deepEqual(Object.keys(value).sort(), ["arch", "buildCommit", "buildVersion", "osRelease", "platform", "schemaVersion", "systemBootTimeUtc"].sort());
  assert.equal(Object.isFrozen(value), true);
  assert.equal(MINUTE_MS, 60000);
});

test("app relaunch during the same OS boot preserves boot and build identity evidence", () => {
  const first = evidence(Date.parse("2026-09-15T01:00:30.000Z"), 3630);
  const second = evidence(Date.parse("2026-09-15T01:12:30.000Z"), 4350);
  assert.equal(first.systemBootTimeUtc, second.systemBootTimeUtc);
  assert.equal(first.buildVersion, second.buildVersion);
  assert.equal(first.buildCommit, second.buildCommit);
});

test("a real OS reboot changes systemBootTimeUtc without changing packaged build identity", () => {
  const before = evidence(Date.parse("2026-09-15T01:00:30.000Z"), 3630);
  const after = evidence(Date.parse("2026-09-15T01:20:30.000Z"), 90);

  assert.notEqual(before.systemBootTimeUtc, after.systemBootTimeUtc);
  assert.equal(after.systemBootTimeUtc, "2026-09-15T01:19:00.000Z");
  assert.equal(before.buildCommit, after.buildCommit);
  assert.equal(before.buildVersion, after.buildVersion);
});
