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

function intervalsOverlap(left, right) {
  const leftStart = Number(left?.startedAt || left?.assignedAt) || 0;
  const rightStart = Number(right?.startedAt || right?.assignedAt) || 0;
  if (!leftStart || !rightStart) return false;
  const leftEnd = Number(left?.finishedAt) || Number.MAX_SAFE_INTEGER;
  const rightEnd = Number(right?.finishedAt) || Number.MAX_SAFE_INTEGER;
  return leftStart <= rightEnd && rightStart <= leftEnd;
}

function observedParallelWorkerRuns(runs = []) {
  const workerRuns = runs.filter((run) => run?.agentId && run?.taskId && !String(run.taskId).startsWith("planning:"));
  for (let index = 0; index < workerRuns.length; index += 1) {
    for (let other = index + 1; other < workerRuns.length; other += 1) {
      if (workerRuns[index].agentId === workerRuns[other].agentId) continue;
      if (intervalsOverlap(workerRuns[index], workerRuns[other])) return true;
    }
  }
  return false;
}

class ManagedBrowserDesktopHost extends DesktopHost {
  constructor(options = {}) {
    if (typeof options.agentRuntime?.bindHostHandlers !== "function") throw new TypeError("managed_browser_agent_runtime_required");
    super({ ...options, autoSeedFakeLead: false });
    this.managedBrowserRecoveryRegistry = new ManagedBrowserRecoveryRegistry(this.agentRuntime);
    // Legacy Core engines still use integer tabId as a liveness hint. Route only their
    // registry view through a compatibility adapter; the actual AgentRuntime continues
    // to expose opaque sessionId bindings and remains the source of truth.
    this.schedulerEngine.registry = this.managedBrowserRecoveryRegistry;
    this.reviewEngine.registry = this.managedBrowserRecoveryRegistry;
    this.integrationEngine.registry = this.managedBrowserRecoveryRegistry;
    this.recoveryController.registry = this.managedBrowserRecoveryRegistry;
    this.managedBrowserValidationObservations = {
      runtimeMessages: 0,
      assistantCompletions: 0,
      protocolErrors: 0,
      sessionLosses: 0,
      sessionRecoveries: 0
    };
    this.managedBrowserLostAgentIds = new Set();
    this.managedBrowserUnbind = bindManagedBrowserAgentRuntime(this);
    this.managedBrowserOnboardingSession = null;
  }

  noteManagedBrowserRuntimeMessage(message, sender) {
    const observations = this.managedBrowserValidationObservations;
    observations.runtimeMessages += 1;
    const TYPES = this.root.MESSAGE_TYPES || {};
    if (message?.type === TYPES.ASSISTANT_RESPONSE_COMPLETED) observations.assistantCompletions += 1;
    if (message?.type === TYPES.PROTOCOL_ERROR) observations.protocolErrors += 1;
    const agentId = sender?.agentId || null;
    if (agentId && this.managedBrowserLostAgentIds.has(agentId) && this.agentRuntime.isAgentConnected?.(agentId)) {
      this.managedBrowserLostAgentIds.delete(agentId);
      observations.sessionRecoveries += 1;
    }
  }

  noteManagedBrowserSessionRemoved(agent) {
    this.managedBrowserValidationObservations.sessionLosses += 1;
    if (agent?.agentId) this.managedBrowserLostAgentIds.add(agent.agentId);
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

  async managedBrowserValidation() {
    const status = (await this.managedBrowserStatus()).managedBrowser;
    const project = this.projectStore.getActiveProject?.() || null;
    const scheduler = this.schedulerStore.summary?.() || {};
    const tasks = this.schedulerStore.listTasks?.() || [];
    const runs = this.schedulerStore.listRuns?.() || [];
    const reviews = this.reviewStore.list?.() || [];
    const reviewSummary = this.reviewStore.summary?.() || {};
    const integration = this.integrationStore.summary?.() || {};
    const recovery = this.recoveryStore.summary?.() || {};
    const agents = this.agentRuntime.listAgents?.() || [];
    const workers = agents.filter((agent) => agent.role === "worker");
    const observations = this.managedBrowserValidationObservations;
    const projectStatus = String(project?.status || "IDLE");
    const integrationStatus = String(integration.status || "IDLE");
    const recoveryStatus = String(recovery.status || "IDLE");
    const planningCompleted = Boolean(
      project?.taskGraph?.tasks?.length
      && project?.artifacts?.DAG_CRITIC
      && !["NEW", "PLANNING", "FAILED"].includes(projectStatus)
    );
    const independentReviewObserved = reviews.some((review) => (
      review?.authorAgentId
      && review?.reviewerAgentId
      && review.authorAgentId !== review.reviewerAgentId
    ));
    const integrationVerified = [projectStatus, String(scheduler.status || ""), integrationStatus].includes("INTEGRATION_VERIFIED");
    const recoveryHealthy = !["RECOVERY_REQUIRED", "NEEDS_USER", "ERROR", "FAILED"].includes(recoveryStatus);
    const checks = {
      chatgptReady: Boolean(!status.loginRequired && ["ready", "generating"].includes(String(status.availability || ""))),
      leadRegistered: Boolean(status.leadRegistered),
      assistantCompletionObserved: observations.assistantCompletions > 0,
      projectStarted: Boolean(project),
      planningCompleted,
      parallelWorkersObserved: observedParallelWorkerRuns(runs),
      dependencyGraphObserved: tasks.some((task) => (task.dependencies || task.definition?.dependencies || []).length > 0),
      independentReviewObserved,
      integrationVerified,
      sessionRecoveryObserved: observations.sessionRecoveries > 0,
      recoveryHealthy
    };
    return {
      ok: true,
      validation: {
        schemaVersion: 1,
        runtimeKind: "desktop-managed-browser",
        capturedAt: this.clock(),
        complete: Object.values(checks).every(Boolean),
        checks,
        state: {
          chatgptAvailability: String(status.availability || "unavailable"),
          leadStatus: status.leadStatus || null,
          projectStatus,
          planningStage: project?.stage || null,
          schedulerStatus: scheduler.status || null,
          reviewStatus: reviewSummary.status || null,
          integrationStatus,
          recoveryStatus
        },
        counts: {
          agents: agents.length,
          workers: workers.length,
          tasks: tasks.length,
          workerRuns: runs.length,
          completedWorkerRuns: runs.filter((run) => run.status === "DONE").length,
          reviews: reviews.length,
          assistantCompletions: observations.assistantCompletions,
          protocolErrors: observations.protocolErrors,
          sessionLosses: observations.sessionLosses,
          sessionRecoveries: observations.sessionRecoveries
        }
      }
    };
  }

  async exportManagedBrowserValidation() {
    const result = await this.managedBrowserValidation();
    const capturedAt = Number(result.validation?.capturedAt) || this.clock();
    return {
      ok: true,
      filename: `chatgpt-orchestra-managed-browser-validation-${capturedAt}.json`,
      serialized: JSON.stringify(result.validation, null, 2)
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
    const query = String(name || "");
    if (query === "managedBrowserStatus") {
      if (!this.initialized) throw new Error("desktop_host_not_initialized");
      return this.managedBrowserStatus();
    }
    if (query === "managedBrowserValidation") {
      if (!this.initialized) throw new Error("desktop_host_not_initialized");
      return this.managedBrowserValidation();
    }
    return super.query(query, payload);
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
    if (command === "exportManagedBrowserValidation") {
      if (!this.initialized) throw new Error("desktop_host_not_initialized");
      return this.exportManagedBrowserValidation();
    }
    return super.execute(command, payload);
  }

  async close() {
    try { this.managedBrowserUnbind?.(); } catch (_) {}
    this.managedBrowserUnbind = null;
    this.managedBrowserLostAgentIds.clear();
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
  createManagedBrowserDesktopHost,
  intervalsOverlap,
  observedParallelWorkerRuns
};
