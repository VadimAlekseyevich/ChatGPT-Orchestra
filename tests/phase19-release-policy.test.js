const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { resolveDesktopRuntimeMode, RUNTIME_MODES } = require("../apps/desktop/main/desktop-runtime-mode.js");
const { DEFAULT_TIMEOUT_MS, DEFAULT_MAX_OUTPUT_BYTES } = require("../platform/node-command-runner.js");
require("../background/scheduler-store.js");
require("../background/review-store.js");
require("../background/integration-store.js");

const ROOT = path.resolve(__dirname, "..");
function read(relative) { return fs.readFileSync(path.join(ROOT, relative), "utf8"); }

const pkg = JSON.parse(read("package.json"));
const electronMain = read("apps/desktop/main/electron-main.js");
const rendererHtml = read("apps/desktop/renderer/index.html");
const managedDriver = read("apps/desktop/main/electron-managed-browser-driver.js");
const repositoryService = read("apps/desktop/main/repository-service.js");

const schedulerDefaults = globalThis.ChatGPTOrchestra.SCHEDULER_DEFAULTS;
const reviewSource = read("background/review-store.js");
const integrationSource = read("background/integration-store.js");

test("desktop-first alpha path defaults to direct managed browser while fallbacks stay explicit", () => {
  assert.equal(resolveDesktopRuntimeMode([], {}), RUNTIME_MODES.MANAGED_BROWSER);
  assert.equal(resolveDesktopRuntimeMode(["--companion"], {}), RUNTIME_MODES.COMPANION);
  assert.equal(resolveDesktopRuntimeMode(["--desktop-shell"], {}), RUNTIME_MODES.DESKTOP);
  assert.equal(pkg.scripts["desktop:dev"], "electron .");
  assert.equal(pkg.scripts["desktop:shell"], "electron . --desktop-shell");
});

test("release reliability budgets remain bounded", () => {
  assert.equal(schedulerDefaults.maxWorkers, 4);
  assert.equal(schedulerDefaults.maxRetries, 2);
  assert.equal(schedulerDefaults.runTimeoutMs, 20 * 60 * 1000);
  assert.equal(DEFAULT_TIMEOUT_MS, 10 * 60 * 1000);
  assert.equal(DEFAULT_MAX_OUTPUT_BYTES, 256 * 1024);
  assert.match(reviewSource, /maxReviewIterations:\s*3/);
  assert.match(integrationSource, /maxRepairAttempts:\s*2/);
  assert.match(integrationSource, /targetPolicy:\s*["']integration_branch_only["']/);
  assert.match(managedDriver, /maxAgents/);
});

test("desktop renderer and browser surfaces retain fail-closed isolation", () => {
  assert.match(rendererHtml, /Content-Security-Policy/);
  assert.match(rendererHtml, /default-src 'self'/);
  assert.match(rendererHtml, /connect-src 'none'/);
  assert.match(rendererHtml, /object-src 'none'/);
  assert.match(electronMain, /contextIsolation:\s*true/);
  assert.match(electronMain, /nodeIntegration:\s*false/);
  assert.match(electronMain, /sandbox:\s*true/);
  assert.match(electronMain, /will-navigate/);
  assert.match(electronMain, /preventDefault/);
});

test("local execution and destructive git surfaces remain explicitly gated", () => {
  assert.match(repositoryService, /setRepositoryTrust/);
  assert.match(repositoryService, /activeVerificationRuns/);
  assert.match(repositoryService, /cancelVerification/);
  assert.match(repositoryService, /validated:\s*payload\.validated\s*===\s*true/);
  assert.match(repositoryService, /force:\s*payload\.force\s*===\s*true/);
});

test("alpha updater policy is manual-only until signed publishing is configured", () => {
  assert.equal(Boolean(pkg.dependencies?.["electron-updater"] || pkg.devDependencies?.["electron-updater"]), false);
  assert.doesNotMatch(electronMain, /autoUpdater|electron-updater/);
});
