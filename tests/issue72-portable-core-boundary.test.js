const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const CORE_FILES = [
  "background/planning-engine.js",
  "background/scheduler-engine.js",
  "background/review-engine.js",
  "background/integration-engine.js",
  "background/recovery-controller.js",
  "background/orchestrator.js",
  "background/orchestrator-api.js",
  "background/event-bus.js",
  "background/event-store.js",
  "background/project-store.js",
  "background/scheduler-store.js",
  "background/review-store.js",
  "background/integration-store.js",
  "background/recovery-store.js",
  "background/task-control-service.js",
  "background/observability-service.js"
];

function walk(relative) {
  const absolute = path.join(ROOT, relative);
  const stat = fs.statSync(absolute);
  if (stat.isFile()) return [relative];
  return fs.readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) return walk(child);
    return entry.isFile() && entry.name.endsWith(".js") ? [child] : [];
  });
}

const PORTABLE_FILES = [
  ...CORE_FILES,
  ...walk("protocol"),
  ...walk("prompts"),
  ...walk("context"),
  ...walk("persistence")
];

const PLATFORM_PATTERNS = [
  [/\bchrome\s*\./, "chrome API"],
  [/require\s*\(\s*["']electron["']\s*\)/, "Electron import"],
  [/\bBrowserWindow\b/, "BrowserWindow"],
  [/\bWebContents\b/, "WebContents"],
  [/\bMutationObserver\b/, "MutationObserver"],
  [/\bquerySelector\b/, "querySelector"],
  [/content\/selectors/, "content selectors"],
  [/electron-managed-browser-/, "managed-browser implementation"],
  [/electron-preload-/, "preload implementation"]
];

const HANDLE_ALLOWLIST = new Set([
  "background/event-store.js",
  "background/observability-service.js",
  "context/context-packets.js",
  "persistence/portable-state.js"
]);

test("portable Core source does not depend on browser or DOM implementations", () => {
  for (const relative of PORTABLE_FILES) {
    const source = fs.readFileSync(path.join(ROOT, relative), "utf8");
    for (const [pattern, label] of PLATFORM_PATTERNS) {
      assert.equal(pattern.test(source), false, `${relative} must not reference ${label}`);
    }
  }
});

test("portable Core source does not add runtime binding handles as behavioral dependencies", () => {
  const forbidden = /\b(tabId|legacyTabId|sessionId|composerOccupied)\b/;
  for (const relative of PORTABLE_FILES) {
    if (HANDLE_ALLOWLIST.has(relative)) continue;
    const source = fs.readFileSync(path.join(ROOT, relative), "utf8");
    assert.equal(forbidden.test(source), false, `${relative} contains a runtime binding identifier`);
  }
});

test("portable AgentRuntime and FakeAgentRuntime contain no browser session contract", () => {
  const Contracts = require("../platform/contracts.js");
  const { FakeAgentRuntime } = require("../platform/fake-runtime.js");
  for (const method of ["getActiveSession", "getSession", "createSession", "navigateSession", "removeSession", "bindAgentToSession", "createAgentForSession", "sessionIdForAgent"]) {
    assert.equal(Contracts.AGENT_RUNTIME_METHODS.includes(method), false, `${method} leaked into portable AgentRuntime`);
    assert.equal(Contracts.RUNTIME_HOST_CONTROL_METHODS.includes(method), true, `${method} missing from host-control contract`);
    assert.equal(typeof FakeAgentRuntime.prototype[method], "undefined", `FakeAgentRuntime must not emulate ${method}`);
  }
  const runtime = new FakeAgentRuntime({ agents: [{ agentId: "worker-1", role: "worker", status: "IDLE" }] });
  const serialized = JSON.stringify(runtime.snapshot());
  for (const token of ["tabId", "legacyTabId", "sessionId", "composerOccupied"]) assert.equal(serialized.includes(token), false);
});
