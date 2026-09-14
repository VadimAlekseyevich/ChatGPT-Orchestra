"use strict";

const { DesktopHost } = require("./desktop-host.js");
const { ensureDesktopPaths } = require("./app-data.js");
const { ManagedBrowserAgentRuntime } = require("./managed-browser-agent-runtime.js");
const { CompletionAwareManagedBrowserRuntime } = require("./completion-aware-managed-browser-runtime.js");
const { ManagedBrowserCompletionMonitor } = require("./managed-browser-completion-monitor.js");
const { ManagedBrowserProtocolAdapter } = require("./managed-browser-protocol-adapter.js");
const { ElectronManagedBrowserDriver, DEFAULT_CHATGPT_URL } = require("./electron-managed-browser-driver.js");
const { ElectronPreloadChatGPTPageAdapter } = require("./electron-preload-chatgpt-page-adapter.js");
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
  protocolAdapter = null,
  completionMonitor = null,
  completionOptions = null,
  ipcMain = null,
  openLoginWindow = true,
  ...options
} = {}) {
  const resolvedPaths = paths || ensureDesktopPaths({ dataDirectory });
  const clock = options.clock || (() => Date.now());
  const managedPageAdapter = pageAdapter || (!agentRuntime && !driver
    ? new ElectronPreloadChatGPTPageAdapter({ ipcMain, logger: logger || console })
    : null);
  const managedDriver = driver || (agentRuntime ? null : new ElectronManagedBrowserDriver({
    pageAdapter: managedPageAdapter,
    logger: logger || console
  }));

  let managedProtocolAdapter = protocolAdapter || null;
  let managedCompletionMonitor = completionMonitor || null;
  let runtime = agentRuntime || null;
  if (!runtime) {
    managedProtocolAdapter = managedProtocolAdapter || new ManagedBrowserProtocolAdapter({ logger: logger || console });
    managedCompletionMonitor = managedCompletionMonitor || new ManagedBrowserCompletionMonitor({
      driver: managedDriver,
      protocolAdapter: managedProtocolAdapter,
      logger: logger || console,
      ...(completionOptions || {})
    });
    runtime = new CompletionAwareManagedBrowserRuntime({
      driver: managedDriver,
      completionMonitor: managedCompletionMonitor,
      profileDirectory: resolvedPaths.browserProfileDirectory,
      clock,
      logger: logger || console,
      maxAgents: 5
    });
  } else if (!(runtime instanceof ManagedBrowserAgentRuntime) && typeof runtime?.bindHostHandlers !== "function") {
    throw new TypeError("managed_browser_agent_runtime_required");
  }

  const host = new ManagedBrowserDesktopHost({
    ...options,
    paths: resolvedPaths,
    agentRuntime: runtime,
    logger
  });
  host.managedBrowserPageAdapter = managedPageAdapter;
  host.managedBrowserProtocolAdapter = managedProtocolAdapter;
  host.managedBrowserCompletionMonitor = managedCompletionMonitor;
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
