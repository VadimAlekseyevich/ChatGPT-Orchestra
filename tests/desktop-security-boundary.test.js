"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");
const pkg = JSON.parse(read("package.json"));
const electronMain = read("apps/desktop/main/electron-main.js");
const preload = read("apps/desktop/preload.js");
const rendererHtml = read("apps/desktop/renderer/index.html");
const ipcRouter = read("apps/desktop/main/ipc-router.js");
const policy = read("docs/desktop-security-boundary.md");

const ANALYTICS_DEPENDENCIES = [
  "@sentry/electron",
  "@sentry/node",
  "@sentry/browser",
  "posthog-js",
  "posthog-node",
  "analytics-node",
  "@segment/analytics-node",
  "@segment/analytics-next",
  "amplitude-js",
  "@amplitude/analytics-browser",
  "@amplitude/analytics-node",
  "dd-trace",
  "newrelic",
  "@opentelemetry/sdk-node"
];

test("Electron dashboard renderer remains isolated and sandboxed", () => {
  assert.match(electronMain, /contextIsolation:\s*true/);
  assert.match(electronMain, /nodeIntegration:\s*false/);
  assert.match(electronMain, /sandbox:\s*true/);
  assert.match(electronMain, /if \(!url\.startsWith\("file:\/\/"\)\) event\.preventDefault\(\)/);
  assert.match(electronMain, /setWindowOpenHandler/);
  assert.match(electronMain, /return \{ action: "deny" \}/);
});

test("desktop renderer CSP blocks network access and unsafe script sources", () => {
  assert.match(rendererHtml, /Content-Security-Policy/);
  assert.match(rendererHtml, /default-src 'self'/);
  assert.match(rendererHtml, /script-src 'self'/);
  assert.doesNotMatch(rendererHtml, /script-src[^;]*(?:'unsafe-inline'|'unsafe-eval'|https?:)/);
  assert.match(rendererHtml, /connect-src 'none'/);
  assert.match(rendererHtml, /object-src 'none'/);
  assert.match(rendererHtml, /base-uri 'none'/);
  assert.match(rendererHtml, /frame-ancestors 'none'/);
});

test("preload bridge exposes no raw Electron or Node privilege surface", () => {
  assert.match(preload, /contextBridge\.exposeInMainWorld\("orchestraDesktop", Object\.freeze\(/);
  assert.match(preload, /ipcRenderer\.invoke/);
  assert.doesNotMatch(preload, /ipcRenderer\.(?:send|sendSync|on|once|addListener|postMessage)/);
  assert.doesNotMatch(preload, /require\(["']node:(?:fs|child_process|net|http|https|worker_threads)/);
  assert.doesNotMatch(preload, /exposeInMainWorld[^]*ipcRenderer[^]*[,}]\s*ipcRenderer\b/);

  for (const method of ["query", "execute", "selectRepositoryDirectory", "restartApplication"]) {
    assert.match(preload, new RegExp(`\\b${method}\\s*\\(`), `preload_method_missing:${method}`);
  }
});

test("generic desktop IPC is independently allowlisted against platform contracts", () => {
  assert.match(ipcRouter, /API_COMMANDS/);
  assert.match(ipcRouter, /API_QUERIES/);
  assert.match(ipcRouter, /ALLOWED_QUERY_NAMES\.has\(name\)/);
  assert.match(ipcRouter, /ALLOWED_COMMAND_NAMES\.has\(name\)/);
  assert.match(ipcRouter, /desktop_ipc_query_not_allowed/);
  assert.match(ipcRouter, /desktop_ipc_command_not_allowed/);
});

test("alpha has no bundled remote telemetry or analytics SDK", () => {
  const dependencies = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  for (const name of ANALYTICS_DEPENDENCIES) {
    assert.equal(dependencies[name], undefined, `remote_telemetry_dependency_not_allowed:${name}`);
  }
  assert.doesNotMatch(preload, /\bnavigator\.sendBeacon\b/);
  assert.doesNotMatch(electronMain, /\b(?:Sentry|PostHog|Amplitude|Datadog|NewRelic)\b/);
});

test("security boundary documents renderer isolation IPC allowlist and no-telemetry policy", () => {
  for (const marker of [
    "Desktop Alpha Security Boundary",
    "contextIsolation: true",
    "nodeIntegration: false",
    "sandbox: true",
    "connect-src 'none'",
    "IPC allowlist",
    "fails closed at the IPC boundary",
    "no remote telemetry or analytics collection",
    "Telemetry remains opt-in"
  ]) assert.ok(policy.includes(marker), `desktop_security_policy_marker_missing:${marker}`);
});
