const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const PORTABLE_BOUNDARY_FILES = [
  "background/orchestrator.js",
  "background/orchestrator-api.js",
  "background/event-bus.js",
  "background/planning-engine.js",
  "background/scheduler-engine.js",
  "background/review-engine.js",
  "background/integration-engine.js",
  "background/recovery-controller.js",
  "platform/contracts.js",
  "platform/fake-runtime.js"
];

test("portable orchestration boundary has no direct Chrome API dependency", () => {
  for (const relative of PORTABLE_BOUNDARY_FILES) {
    const source = fs.readFileSync(path.join(ROOT, relative), "utf8");
    assert.equal(/\bchrome\s*\./.test(source), false, `${relative} references chrome.* directly`);
    assert.equal(source.includes("globalThis.chrome"), false, `${relative} references globalThis.chrome directly`);
  }
});

test("browser APIs live in extension composition/adapters", () => {
  const extensionRuntime = fs.readFileSync(path.join(ROOT, "platform/extension-runtime.js"), "utf8");
  const serviceWorker = fs.readFileSync(path.join(ROOT, "background/service-worker.js"), "utf8");
  assert.match(extensionRuntime, /globalThis\.chrome|chromeApi/);
  assert.match(serviceWorker, /ChromeStorageStateStore/);
  assert.match(serviceWorker, /ExtensionAgentRuntime/);
  assert.match(serviceWorker, /ChromeAlarmRuntime/);
  assert.match(serviceWorker, /OrchestratorApi/);
});
