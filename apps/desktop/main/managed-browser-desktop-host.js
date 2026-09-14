"use strict";

const { DesktopHost } = require("./desktop-host.js");
const { ensureDesktopPaths } = require("./app-data.js");
const { ManagedBrowserAgentRuntime } = require("./managed-browser-agent-runtime.js");
const { CompletionAwareManagedBrowserRuntime } = require("./completion-aware-managed-browser-runtime.js");
const { ManagedBrowserCompletionMonitor } = require("./managed-browser-completion-monitor.js");
const { ManagedBrowserProtocolAdapter } = require("./managed-browser-protocol-adapter.js");
const { ManagedBrowserRecoveryRegistry } = require("./managed-browser-recovery-registry.js");
const { ElectronManagedBrowserDriver, DEFAULT_CHATGPT_URL } = require("./electron-managed-browser-driver.js");
const { ElectronPreloadChatGPTPageAdapter } = require("./electron-preload-chatgpt-page-adapter.js");
const { bindManagedBrowserAgentRuntime } = require("./managed-browser-host-binding.js");

class ManagedBrowserDesktopHost extends DesktopHost {
  constructor(options = {}) {
    if (typeof options.agentRuntime?.bindHostHandlers !== "function") throw new TypeError("managed_browser_agent_runtime_required");
    super({ ...options, autoSeedFakeLead: false });
    this.managedBrowserRecoveryRegistry = new ManagedBrowserRecoveryRegistry(this.agentRuntime);
    this.recoveryController.registry = this.managedBrowserRecoveryRegistry;
    this.managedBrowserUnbind = bindManagedBrowserAgentRuntime(this);
    this.managedBrowserOnboardingSession = null;
  }

  async onboardingSession() {
    const lead = this.agentRuntime.listAgents?.().find((agent) => agent.role === "lead") || null;
    const leadSessionId = lead ? this.agentRuntime.sessionIdForAgent?.(lead) : null;
    if (leadSessionId) {
      const leadSession = await this.agentRuntime.getSession?.(leadSessionId);
      if (leadSession) return leadSession;
    }
    if (this.managedBrowserOnboardingSession?.id) {
      const stored = await this.agentRuntime.getSession?.(this.managedBrowserOnboardingSession.id);
      if (stored) return stored;
    }
    return this.agentRuntime.getActiveSession?.() || null;
  }

  async managedBrowserStatus() {
    const lead = this.agentRuntime.listAgents?.().find((agent) => agent.role === "lead") || null;
    const session = await this.onboardingSession();
    let page = null;
    if (session?.id && typeof this.agentRuntime.driver?.pingSession === "function") {
      try { page = await this.agentRuntime.driver.pingSession(session.id); }
      catch (error) { page = { ok: false, reason: "managed_browser_page_unreachable", message: String(error?.message || error) }; }
    }
    const availability = String(page?.availability || "unavailable");
    const loginReady = Boolean(page?.ok && ["ready", "generating"].includes(availability));
    return {
      ok: true,
      managedBrowser: {
        runtimeKind: "desktop-managed-browser",
        sessionOpen: Boolean(session?.id),
        sessionId: session?.id || null,
        url: String(page?.url || session?.url || ""),
        availability,
        generating: Boolean(page?.generating),
        loginRequired: !loginReady,
        leadRegistered: Boolean(lead?.agentId),
        leadAgentId: lead?.agentId || null,
        leadStatus: lead?.status || null,
        pageError: page?.ok === false ? String(page.reason || "managed_browser_page_unavailable") : null
      }
    };
  }

  async openManagedBrowser() {
    let session = await this.onboardingSession();
    if (!session?.id) session = await this.agentRuntime.createSession({ url: DEFAULT_CHATGPT_URL, active: true });
    else if (typeof this.agentRuntime.driver?.activateSession === "function") session = await this.agentRuntime.driver.activateSession(session.id);
    this.managedBrowserOnboardingSession = session;
    return this.managedBrowserStatus();
  }

  async registerManagedBrowserLead() {
    const status = await this.managedBrowserStatus();
    if (status.managedBrowser.loginRequired) {
      return { ok: false, reason: "managed_browser_login_required", managedBrowser: status.managedBrowser };
    }
    const opened = await this.openManagedBrowser();
    if (!opened?.ok) return opened;
    const registered = await super.execute("registerActiveLead");
    return { ...registered, managedBrowser: (await this.managedBrowserStatus()).managedBrowser };
  }

  async query(name, payload = {}) {
    if (String(name || "") === "managedBrowserStatus") {
      if (!this.initialized) throw new Error("desktop_host_not_initialized");
      return this.managedBrowserStatus();
    }
    return super.query(name, payload);
  }

  async execute(name, payload = {}) {
    const command = String(name || "");
    if (command === "openManagedBrowser") {
      if (!this.initialized) throw new Error("desktop_host_not_initialized");
      return this.openManagedBrowser();
    }
    if (command === "registerManagedBrowserLead") {
      if (!this.initialized) throw new Error("desktop_host_not_initialized");
      return this.registerManagedBrowserLead();
    }
    return super.execute(command, payload);
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
