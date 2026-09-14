"use strict";

const { DesktopHost } = require("./desktop-host.js");
const { ensureDesktopPaths } = require("./app-data.js");
const { ManagedBrowserAgentRuntime } = require("./managed-browser-agent-runtime.js");
const { ElectronManagedBrowserDriver, DEFAULT_CHATGPT_URL } = require("./electron-managed-browser-driver.js");
const { bindManagedBrowserAgentRuntime } = require("./managed-browser-host-binding.js");

class ManagedBrowserDesktopHost extends DesktopHost {
  constructor(options = {}) {
    if (typeof options.agentRuntime?.bindHostHandlers !== "function") throw new TypeError("managed_browser_agent_runtime_required");
    super({ ...options, autoSeedFakeLead: false });
    this.managedBrowserUnbind = bindManagedBrowserAgentRuntime(this);
  }

  async close() {
    try { this.managedBrowserUnbind?.(); } catch (_) {}
    this.managedBrowserUnbind = null;
    try { await this.agentRuntime.close?.(); } finally { await super.close(); }
  }
}

async function createManagedBrowserDesktopHost({
  dataDirectory = null,
  paths = null,
  logger = null,
  agentRuntime = null,
  driver = null,
  pageAdapter = null,
  openLoginWindow = true,
  ...options
} = {}) {
  const resolvedPaths = paths || ensureDesktopPaths({ dataDirectory });
  const clock = options.clock || (() => Date.now());
  const managedDriver = driver || (agentRuntime ? null : new ElectronManagedBrowserDriver({ pageAdapter, logger: logger || console }));
  const runtime = agentRuntime || new ManagedBrowserAgentRuntime({
    driver: managedDriver,
    profileDirectory: resolvedPaths.browserProfileDirectory,
    clock,
    logger: logger || console,
    maxAgents: 5
  });
  const host = new ManagedBrowserDesktopHost({
    ...options,
    paths: resolvedPaths,
    agentRuntime: runtime,
    logger
  });
  await host.init();

  let onboardingSession = null;
  if (openLoginWindow) {
    onboardingSession = await runtime.getActiveSession();
    if (!onboardingSession) onboardingSession = await runtime.createSession({ url: DEFAULT_CHATGPT_URL, active: true });
  }
  host.managedBrowserOnboardingSession = onboardingSession;
  return host;
}

module.exports = {
  ManagedBrowserDesktopHost,
  createManagedBrowserDesktopHost
};
