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
  "background/observability-service.js",
  "background/task-control-service.js",
  "platform/contracts.js",
  "platform/fake-runtime.js",
  "platform/transactional-state-store.js",
  "persistence/migration-registry.js",
  "persistence/portable-state.js",
  "persistence/project-bundle.js",
  "dashboard/dashboard-app.js",
  "dashboard/fake-transport.js"
];

test("portable orchestration and Dashboard boundary has no direct Chrome API dependency", () => {
  for (const relative of PORTABLE_BOUNDARY_FILES) {
    const source = fs.readFileSync(path.join(ROOT, relative), "utf8");
    assert.equal(/\bchrome\s*\./.test(source), false, `${relative} references chrome.* directly`);
    assert.equal(source.includes("globalThis.chrome"), false, `${relative} references globalThis.chrome directly`);
  }
});

test("Dashboard frontend never reads persistence or internal stores directly", () => {
  const source = fs.readFileSync(path.join(ROOT, "dashboard/dashboard-app.js"), "utf8");
  for (const forbidden of ["chrome.storage", "chrome.tabs", "node:sqlite", "SchedulerStore", "ReviewStore", "IntegrationStore", "RecoveryStore", "ProjectStore"]) {
    assert.equal(source.includes(forbidden), false, `Dashboard references ${forbidden}`);
  }
  assert.match(source, /transport\.query/);
  assert.match(source, /transport\.execute/);
});

test("browser and Node persistence APIs live in host adapters/composition roots", () => {
  const extensionRuntime = fs.readFileSync(path.join(ROOT, "platform/extension-runtime.js"), "utf8");
  const extensionTransport = fs.readFileSync(path.join(ROOT, "dashboard/extension-transport.js"), "utf8");
  const sqliteRuntime = fs.readFileSync(path.join(ROOT, "platform/sqlite-state-store.js"), "utf8");
  const serviceWorker = fs.readFileSync(path.join(ROOT, "background/service-worker.js"), "utf8");
  assert.match(extensionRuntime, /globalThis\.chrome|chromeApi/);
  assert.match(extensionTransport, /chrome|runtime/);
  assert.match(sqliteRuntime, /node:sqlite/);
  assert.match(serviceWorker, /ChromeStorageStateStore/);
  assert.match(serviceWorker, /TransactionalStateStore/);
  assert.match(serviceWorker, /ExtensionAgentRuntime/);
  assert.match(serviceWorker, /ChromeAlarmRuntime/);
  assert.match(serviceWorker, /ObservabilityService/);
  assert.match(serviceWorker, /TaskControlService/);
  assert.match(serviceWorker, /OrchestratorApi/);
});
