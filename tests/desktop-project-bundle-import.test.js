"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  DesktopProjectBundleImport,
  MAX_BUNDLE_BYTES,
  SAFE_IMPORT_STATES
} = require("../apps/desktop/renderer/desktop-project-bundle-import.js");

function fakeRoot() {
  return {
    innerHTML: "",
    addEventListener() {},
    removeEventListener() {},
    querySelector() { return null; }
  };
}

function bundleFile(text = "{\"format\":\"chatgpt-orchestra-project-bundle\"}") {
  return {
    size: Buffer.byteLength(text),
    async text() { return text; }
  };
}

test("desktop Project Bundle import replaces existing portable project only after confirmation and restarts host", async () => {
  const calls = [];
  let restarts = 0;
  const transport = {
    async query(name) {
      assert.equal(name, "dashboard");
      return { ok: true, dashboard: { project: { projectId: "P-old" }, recovery: { status: "PAUSED" } } };
    },
    async execute(name, payload) {
      calls.push({ name, payload });
      return { ok: true, projectId: "P-imported", reloadRequired: true };
    },
    async restartApplication() {
      restarts += 1;
      return { ok: true, restarting: true };
    }
  };
  const root = fakeRoot();
  const app = new DesktopProjectBundleImport({ rootElement: root, transport, confirmAction: () => true });
  await app.refresh();
  assert.equal(app.canImport(), true);
  assert.match(root.innerHTML, /Import Project Bundle/);

  const result = await app.importFile(bundleFile("bundle-text"));
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [{ name: "importProjectBundle", payload: { bundle: "bundle-text", replace: true } }]);
  assert.equal(restarts, 1);
  assert.match(root.innerHTML, /Imported P-imported/);
});

test("desktop Project Bundle import cancellation never mutates state", async () => {
  let executes = 0;
  const transport = {
    async query() { return { ok: true, dashboard: { project: { projectId: "P-old" }, recovery: { status: "STOPPED" } } }; },
    async execute() { executes += 1; return { ok: true }; },
    async restartApplication() { return { ok: true }; }
  };
  const app = new DesktopProjectBundleImport({ rootElement: fakeRoot(), transport, confirmAction: () => false });
  await app.refresh();
  const result = await app.importFile(bundleFile("bundle"));
  assert.equal(result.cancelled, true);
  assert.equal(executes, 0);
});

test("desktop Project Bundle import is disabled outside safe recovery states", async () => {
  for (const status of ["RUNNING", "PAUSING", "STOPPING", "RECOVERING"]) {
    let executes = 0;
    const root = fakeRoot();
    const transport = {
      async query() { return { ok: true, dashboard: { project: { projectId: "P1" }, recovery: { status } } }; },
      async execute() { executes += 1; return { ok: true }; }
    };
    const app = new DesktopProjectBundleImport({ rootElement: root, transport, confirmAction: () => true });
    await app.refresh();
    assert.equal(app.canImport(), false, status);
    assert.match(root.innerHTML, /blocked until Pause\/Stop\/recovery safe point/);
    const result = await app.importFile(bundleFile("bundle"));
    assert.equal(result.ok, false);
    assert.match(result.reason, /not allowed/);
    assert.equal(executes, 0);
  }
  assert.deepEqual([...SAFE_IMPORT_STATES].sort(), ["IDLE", "PAUSED", "RECOVERY_REQUIRED", "STOPPED"]);
});

test("desktop Project Bundle import rejects oversized files before API mutation", async () => {
  let executes = 0;
  const transport = {
    async query() { return { ok: true, dashboard: { project: null, recovery: { status: "IDLE" } } }; },
    async execute() { executes += 1; return { ok: true }; }
  };
  const app = new DesktopProjectBundleImport({ rootElement: fakeRoot(), transport });
  await app.refresh();
  const result = await app.importFile({ size: MAX_BUNDLE_BYTES + 1, async text() { throw new Error("must_not_read"); } });
  assert.equal(result.ok, false);
  assert.match(result.reason, /larger than 8 MiB/);
  assert.equal(executes, 0);
});

test("packaged desktop wires browser-safe bundle input and narrow restart IPC", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "apps", "desktop", "renderer", "index.html"), "utf8");
  const renderer = fs.readFileSync(path.join(__dirname, "..", "apps", "desktop", "renderer", "renderer.js"), "utf8");
  const component = fs.readFileSync(path.join(__dirname, "..", "apps", "desktop", "renderer", "desktop-project-bundle-import.js"), "utf8");
  const transport = fs.readFileSync(path.join(__dirname, "..", "apps", "desktop", "renderer", "desktop-transport.js"), "utf8");
  const preload = fs.readFileSync(path.join(__dirname, "..", "apps", "desktop", "preload.js"), "utf8");
  const main = fs.readFileSync(path.join(__dirname, "..", "apps", "desktop", "main", "electron-main.js"), "utf8");

  assert.match(html, /id="desktopProjectBundleImport"/);
  assert.match(html, /desktop-project-bundle-import\.js/);
  assert.match(renderer, /DesktopProjectBundleImport/);
  assert.match(component, /file\.text\(\)/);
  assert.match(component, /importProjectBundle/);
  assert.doesNotMatch(component, /require\(/);
  assert.match(transport, /restartApplication/);
  assert.match(preload, /orchestra:restart-application/);
  assert.match(main, /app\.relaunch\(\)/);
  assert.doesNotMatch(preload, /node:fs/);
});
