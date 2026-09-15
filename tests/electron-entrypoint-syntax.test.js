"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const packageJson = require("../package.json");

test("packaged Electron main entrypoint passes Node syntax check", () => {
  const entrypoint = path.join(__dirname, "..", packageJson.main);
  const result = spawnSync(process.execPath, ["--check", entrypoint], {
    encoding: "utf8"
  });

  assert.equal(
    result.status,
    0,
    `Electron main entrypoint failed syntax validation:\n${result.stderr || result.stdout}`
  );
});
