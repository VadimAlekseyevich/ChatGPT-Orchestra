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

function evidence(clockMs, uptimeSeconds) {
  return createDesktopRuntimeEvidence({
    clock: () => clockMs,
    uptime: () => uptimeSeconds,
    platform: PLATFORM,
    arch: ARCH,
    release: () => RELEASE
  });
}

test("desktop runtime evidence reports only non-secret host and rounded boot metadata", () => {
  const now = Date.parse("2026-09-15T01:00:30.000Z");
  const value = evidence(now, 3630);

  assert.deepEqual(value, {
    schemaVersion: 1,
    platform: PLATFORM,
    arch: ARCH,
    osRelease: RELEASE,
    systemBootTimeUtc: "2026-09-15T00:00:00.000Z"
  });
  assert.deepEqual(Object.keys(value).sort(), ["arch", "osRelease", "platform", "schemaVersion", "systemBootTimeUtc"].sort());
  assert.equal(Object.isFrozen(value), true);
  assert.equal(MINUTE_MS, 60000);
});

test("app relaunch during the same OS boot preserves the boot evidence", () => {
  const first = evidence(Date.parse("2026-09-15T01:00:30.000Z"), 3630);
  const second = evidence(Date.parse("2026-09-15T01:12:30.000Z"), 4350);
  assert.equal(first.systemBootTimeUtc, second.systemBootTimeUtc);
});

test("a real OS reboot changes systemBootTimeUtc", () => {
  const before = evidence(Date.parse("2026-09-15T01:00:30.000Z"), 3630);
  const after = evidence(Date.parse("2026-09-15T01:20:30.000Z"), 90);

  assert.notEqual(before.systemBootTimeUtc, after.systemBootTimeUtc);
  assert.equal(after.systemBootTimeUtc, "2026-09-15T01:19:00.000Z");
});
