"use strict";

const os = require("node:os");

const MINUTE_MS = 60 * 1000;

function finiteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function createDesktopRuntimeEvidence({
  clock = () => Date.now(),
  uptime = () => os.uptime(),
  platform = process.platform,
  arch = process.arch,
  release = () => os.release()
} = {}) {
  const nowMs = finiteNumber(clock(), Date.now());
  const uptimeMs = Math.max(0, finiteNumber(uptime(), 0) * 1000);
  const bootMs = Math.max(0, nowMs - uptimeMs);
  const roundedBootMs = Math.floor(bootMs / MINUTE_MS) * MINUTE_MS;

  return Object.freeze({
    schemaVersion: 1,
    platform: String(platform || "unknown"),
    arch: String(arch || "unknown"),
    osRelease: String(typeof release === "function" ? release() : release || "unknown"),
    systemBootTimeUtc: new Date(roundedBootMs).toISOString()
  });
}

module.exports = {
  MINUTE_MS,
  createDesktopRuntimeEvidence
};
