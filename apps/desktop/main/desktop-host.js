"use strict";

const { ensureDesktopPaths } = require("./app-data.js");
const { StructuredLogger } = require("./structured-logger.js");
const { loadDesktopCore } = require("./core-loader.js");
const { DesktopRepositoryService } = require("./repository-service.js");
const { createLocalPlanningEngine } = require("./local-planning-engine.js");
const { LocalValidatingGitProvider } = require("./local-validating-git-provider.js");
const { LocalIntegrationCoordinator } = require("./local-integration-coordinator.js");
const { createLocalIntegrationEngine } = require("./local-integration-engine.js");
const { createLocalReviewEngine } = require("./local-review-engine.js");
const { createLocalSchedulerEngine } = require("./local-scheduler-engine.js");
const { createLocalOrchestrator } = require("./local-orchestrator.js");
const { createDesktopRuntimeEvidence } = require("./runtime-evidence.js");
const { SQLiteStateStore } = require("../../../platform/sqlite-state-store.js");
const { FakeAgentRuntime } = require("../../../platform/fake-runtime.js");
const { NodeTimerRuntime } = require("../../../platform/node-timer-runtime.js");

const WATCHDOG_NAME = "orchestra-desktop-watchdog";

function jsonClone(value) {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value));
}

function payloadKeys(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  return Object.keys(payload).sort().slice(0, 32);
}

function resultSummary(result) {
  if (!result || typeof result !== "object") return { ok: result !== false, reason: null, keys: [] };
  return {
    ok: result.ok !== false,
    reason: result.reason || null,
    keys: Object.keys(result).sort().slice(0, 32)
  };
}

function hostNow(host) {
  return typeof host?.clock === "function" ? host.clock() : Date.now();
}

function hostDiagnosticLogger(host) {
  return host?.hostLogger || host?.logger || null;
}

class DesktopHost {
  constructor({
    dataDirectory = null,
    paths = null,
    stateStore = null,
    agentRuntime = null,
    timerRuntime = null,
    gitProvider = null,
    repositoryService = null,
    logger = null,
    clock = () => Date.now(),
    runtimeEvidence = null,
    autoSeedFakeLead = true
  } = {}) {
    this.root = loadDesktopCore();
    this.paths = paths || ensureDesktopPaths({ dataDirectory });
    this.logger = logger || new StructuredLogger({ filename: this.paths.logFile, clock });
    this.hostLogger = this.logger.child?.("desktop-host") || this.logger;
    this.componentLogger = (component) => this.logger.child?.(component) || this.logger;
    this.clock = clock;
    this.requestSequence = 0;
    this.runtimeEvidence = runtimeEvidence || createDesktopRuntimeEvidence({ clock });
    this.ownsStateStore = !stateStore;
    this.ownsTimerRuntime = !timerRuntime;
    this.persistenceBackend = stateStore ? "injected" : "sqlite";
    this.stateStore = stateStore || new SQLiteStateStore({ filename: this.paths.stateDatabase, clock });
    this.agentRuntime = agentRuntime || new FakeAgentRuntime({ clock });
    this.timerRuntime = timerRuntime || new NodeTimerRuntime({ logger: this.componentLogger("timer") });
    this.repositoryService = repositoryService || new DesktopRepositoryService({ stateStore: this.stateStore, paths: this.paths, clock, logger: this.componentLogger("repository") });
    this.remoteGitProvider = gitProvider || new this.root.GitProvider.GitHubRestProvider({ logger: this.componentLogger("git-remote"), clock });
    this.gitProvider = new LocalValidatingGitProvider({ remoteProvider: this.remoteGitProvider, repositoryService: this.repositoryService, logger: this.componentLogger("git-local") });
    this.localIntegrationCoordinator = new LocalIntegrationCoordinator({ repositoryService: this.repositoryService, clock, logger: this.componentLogger("integration-local") });
    this.autoSeedFakeLead = autoSeedFakeLead;
    this.initialized = false;
    this.closed = false;
    this.watchdogCancel = null;
    this.buildComposition();
  }

  buildComposition() {
    const root = this.root;
    root.PlatformContracts.assertTransactionalStateStore(this.stateStore);
    root.PlatformContracts.assertAgentRuntime(this.agentRuntime);
    root.PlatformContracts.assertTimerRuntime(this.timerRuntime);

    this.eventStore = new root.EventStore({ stateStore: this.stateStore });
    this.eventBus = new root.EventBus({ registry: this.agentRuntime, store: this.eventStore, logger: this.componentLogger("event-bus") });
    this.projectStore = new root.ProjectStore({ storageArea: this.stateStore });
    this.schedulerStore = new root.SchedulerStore({ storageArea: this.stateStore });
    this.reviewStore = new root.ReviewStore({ storageArea: this.stateStore });
    this.integrationStore = new root.IntegrationStore({ storageArea: this.stateStore });
    this.recoveryStore = new root.RecoveryStore({ storageArea: this.stateStore });
    this.contextStore = new root.ContextStore({ storageArea: this.stateStore });

    this.migrationRegistry = new root.MigrationRegistry({ currentVersion: root.PortableState.PORTABLE_SCHEMA_VERSION });
    this.portableStateManager = new root.PortableState.PortableStateManager({ stateStore: this.stateStore, migrations: this.migrationRegistry });
    this.projectBundleService = new root.ProjectBundle.ProjectBundleService({ portableStateManager: this.portableStateManager, sourceHost: "desktop-node" });
    this.persistenceInfo = () => ({
      backend: this.persistenceBackend,
      transactional: true,
      host: "desktop-node",
      runtimeEvidence: { ...this.runtimeEvidence }
    });

    this.contextPackets = new root.ContextPackets.ContextPacketService({
      contextStore: this.contextStore,
      projectStore: this.projectStore,
      schedulerStore: this.schedulerStore,
      reviewStore: this.reviewStore,
      integrationStore: this.integrationStore,
      recoveryStore: this.recoveryStore
    });
    root.ContextPackets.setDefaultService(this.contextPackets);

    const LocalPlanningEngine = createLocalPlanningEngine(root.PlanningEngine);
    const LocalIntegrationEngine = createLocalIntegrationEngine(root.RecoverableIntegrationEngine);
    const LocalReviewEngine = createLocalReviewEngine(root.ReviewEngine);
    const LocalSchedulerEngine = createLocalSchedulerEngine(root.SchedulerEngine);
    const LocalOrchestrator = createLocalOrchestrator(root.ServiceWorkerOrchestrator);
    this.schedulerEngine = null;
    this.planningEngine = new LocalPlanningEngine({
      projectStore: this.projectStore,
      registry: this.agentRuntime,
      eventBus: this.eventBus,
      sendPrompt: (agentId, prompt) => this.agentRuntime.sendPrompt(agentId, prompt)
    });
    this.reviewEngine = new LocalReviewEngine({
      store: this.reviewStore,
      schedulerStore: this.schedulerStore,
      projectStore: this.projectStore,
      registry: this.agentRuntime,
      eventBus: this.eventBus,
      gitProvider: this.gitProvider,
      repositoryService: this.repositoryService,
      sendPrompt: (agentId, prompt) => this.agentRuntime.sendPrompt(agentId, prompt),
      onSchedulerTick: (options) => this.schedulerEngine?.tick(options)
    });
    this.integrationEngine = new LocalIntegrationEngine({
      store: this.integrationStore,
      schedulerStore: this.schedulerStore,
      projectStore: this.projectStore,
      registry: this.agentRuntime,
      eventBus: this.eventBus,
      gitProvider: this.gitProvider,
      sendPrompt: (agentId, prompt) => this.agentRuntime.sendPrompt(agentId, prompt),
      localIntegrationCoordinator: this.localIntegrationCoordinator
    });
    this.schedulerEngine = new LocalSchedulerEngine({
      store: this.schedulerStore,
      projectStore: this.projectStore,
      registry: this.agentRuntime,
      eventBus: this.eventBus,
      gitProvider: this.gitProvider,
      reviewEngine: this.reviewEngine,
      sendPrompt: (agentId, prompt) => this.sendWorkerPromptWithWorkspace(agentId, prompt)
    });
    this.orchestrator = new LocalOrchestrator({
      agentRuntime: this.agentRuntime,
      eventBus: this.eventBus,
      planningEngine: this.planningEngine,
      schedulerEngine: this.schedulerEngine,
      logger: this.componentLogger("orchestrator")
    });

    this.recoveryController = new root.RecoveryController({
      store: this.recoveryStore,
      projectStore: this.projectStore,
      schedulerStore: this.schedulerStore,
      reviewStore: this.reviewStore,
      integrationStore: this.integrationStore,
      registry: this.agentRuntime,
      planningEngine: this.planningEngine,
      schedulerEngine: this.schedulerEngine,
      reviewEngine: this.reviewEngine,
      integrationEngine: this.integrationEngine,
      gitProvider: this.gitProvider,
      logger: this.componentLogger("recovery")
    });
    root.RecoveryRuntime.controller = this.recoveryController;
    this.recoveryController.setActions({
      stopAgent: (agentId) => this.agentRuntime.stopAgent(agentId),
      createWorkers: (count) => this.orchestrator.createWorkers(count),
      reconcileTabs: () => this.orchestrator.reconcileRegisteredSessions()
    });

    this.observabilityService = new root.ObservabilityService({
      projectStore: this.projectStore,
      schedulerStore: this.schedulerStore,
      reviewStore: this.reviewStore,
      integrationStore: this.integrationStore,
      registry: this.agentRuntime,
      eventBus: this.eventBus,
      recoveryController: this.recoveryController,
      persistenceInfo: this.persistenceInfo
    });
    this.taskControlService = new root.TaskControlService({
      schedulerStore: this.schedulerStore,
      schedulerEngine: this.schedulerEngine,
      reviewStore: this.reviewStore,
      reviewEngine: this.reviewEngine,
      integrationEngine: this.integrationEngine,
      registry: this.agentRuntime,
      recoveryController: this.recoveryController
    });
    this.orchestratorApi = new root.OrchestratorApi({
      orchestrator: this.orchestrator,
      planningEngine: this.planningEngine,
      schedulerEngine: this.schedulerEngine,
      reviewEngine: this.reviewEngine,
      integrationEngine: this.integrationEngine,
      recoveryController: this.recoveryController,
      eventBus: this.eventBus,
      projectBundleService: this.projectBundleService,
      persistenceInfo: this.persistenceInfo,
      observabilityService: this.observabilityService,
      taskControlService: this.taskControlService,
      contextStore: this.contextStore,
      contextPackets: this.contextPackets,
      repositoryService: this.repositoryService
    });
  }

  async traceApiCall(kind, name, payload, action) {
    this.requestSequence = Number.isFinite(this.requestSequence) ? this.requestSequence + 1 : 1;
    const requestId = `${kind}-${this.requestSequence}`;
    const startedAt = hostNow(this);
    const level = kind === "query" ? "debug" : "info";
    const logger = hostDiagnosticLogger(this);
    logger?.[level]?.(`desktop_api_${kind}_started`, {
      requestId,
      name: String(name || ""),
      payloadKeys: payloadKeys(payload)
    });
    try {
      const result = await action();
      logger?.[level]?.(`desktop_api_${kind}_completed`, {
        requestId,
        name: String(name || ""),
        durationMs: Math.max(0, hostNow(this) - startedAt),
        ...resultSummary(result)
      });
      return result;
    } catch (error) {
      logger?.error?.(`desktop_api_${kind}_failed`, {
        requestId,
        name: String(name || ""),
        durationMs: Math.max(0, hostNow(this) - startedAt),
        error
      });
      throw error;
    }
  }

  async traceInitPhase(phase, action) {
    const startedAt = hostNow(this);
    const logger = hostDiagnosticLogger(this);
    logger?.debug?.("desktop_init_phase_started", { phase });
    try {
      const result = await action();
      logger?.debug?.("desktop_init_phase_completed", {
        phase,
        durationMs: Math.max(0, hostNow(this) - startedAt)
      });
      return result;
    } catch (error) {
      logger?.error?.("desktop_init_phase_failed", {
        phase,
        durationMs: Math.max(0, hostNow(this) - startedAt),
        error
      });
      throw error;
    }
  }

  async sendWorkerPromptWithWorkspace(agentId, prompt) {
    const startedAt = hostNow(this);
    const logger = hostDiagnosticLogger(this);
    const promptBytes = Buffer.byteLength(String(prompt || ""), "utf8");
    const agent = this.agentRuntime.getAgent?.(agentId) || null;
    const context = agent?.protocolContext || null;
    const run = context?.runId ? this.schedulerStore.getRun?.(context.runId) : null;
    const taskState = context?.taskId ? this.schedulerStore.getTask?.(context.taskId) : null;
    const project = this.projectStore.getActiveProject?.() || null;
    logger?.info?.("worker_prompt_dispatch_started", {
      agentId: String(agentId || ""),
      taskId: context?.taskId || null,
      runId: context?.runId || null,
      promptBytes
    });
    if (run && taskState && project && this.gitProvider?.prepareRun) {
      const task = taskState.definition || taskState;
      const prepared = await this.gitProvider.prepareRun({ project, task, run, snapshot: this.schedulerStore.getGitSnapshot?.() || null });
      if (!prepared?.ok) {
        const failed = { ok: false, reason: "local_workspace_prepare_failed", details: { reason: prepared?.reason || "unknown", runId: run.runId, taskId: task.id } };
        logger?.warn?.("worker_prompt_dispatch_blocked", {
          agentId: String(agentId || ""),
          taskId: task.id,
          runId: run.runId,
          durationMs: Math.max(0, hostNow(this) - startedAt),
          reason: failed.reason,
          details: failed.details
        });
        return failed;
      }
      if (!prepared.skipped) {
        await this.schedulerStore.logDecision?.("task_workspace_prepared", {
          taskId: task.id,
          runId: run.runId,
          workspaceId: prepared.workspaceId,
          created: prepared.created === true,
          recovered: prepared.recovered === true
        });
      }
    }
    try {
      const result = await this.agentRuntime.sendPrompt(agentId, prompt);
      logger?.info?.("worker_prompt_dispatch_completed", {
        agentId: String(agentId || ""),
        taskId: context?.taskId || null,
        runId: context?.runId || null,
        promptBytes,
        durationMs: Math.max(0, hostNow(this) - startedAt),
        ok: result?.ok !== false,
        reason: result?.reason || null
      });
      return result;
    } catch (error) {
      logger?.error?.("worker_prompt_dispatch_failed", {
        agentId: String(agentId || ""),
        taskId: context?.taskId || null,
        runId: context?.runId || null,
        promptBytes,
        durationMs: Math.max(0, hostNow(this) - startedAt),
        error
      });
      throw error;
    }
  }

  async seedFakeLead() {
    if (!this.autoSeedFakeLead || !(this.agentRuntime instanceof this.root.FakeAgentRuntime)) return null;
    const existing = this.agentRuntime.listAgents().find((agent) => agent.role === "lead");
    if (existing) return existing;
    const session = await this.agentRuntime.createSession({ url: "https://chatgpt.com/", active: true });
    return this.agentRuntime.createAgentForSession({ role: "lead", session, chatUrl: session.url, label: "Lead", status: "IDLE" });
  }

  async readyFakeWorkers(reason = "desktop_fake_runtime") {
    if (!(this.agentRuntime instanceof this.root.FakeAgentRuntime)) return { ready: 0 };
    let ready = 0;
    for (const agent of this.agentRuntime.listAgents()) {
      if (agent.role !== "worker" || agent.status !== "CONNECTING") continue;
      const ping = await this.agentRuntime.pingAgent(agent.agentId);
      if (ping?.ok) ready += 1;
    }
    if (ready > 0) await this.schedulerEngine.tick({ reason: `fake_workers_ready:${reason}` });
    return { ready };
  }

  async init() {
    if (this.closed) throw new Error("desktop_host_closed");
    if (this.initialized) return this.query("state");
    const startedAt = this.clock();
    this.hostLogger.info?.("desktop_host_starting", {
      backend: this.persistenceBackend,
      runtimeKind: this.agentRuntime?.constructor?.name || "unknown"
    });
    await this.traceInitPhase("seed_fake_lead", () => this.seedFakeLead());
    await this.traceInitPhase("context_packets", () => this.contextPackets.init());
    await this.traceInitPhase("recovery_prepare", () => this.recoveryController.prepareForBoot());
    await this.traceInitPhase("orchestrator", () => this.orchestrator.init());
    await this.traceInitPhase("integration", () => this.integrationEngine.init());
    await this.traceInitPhase("recovery_after_runtime", () => this.recoveryController.afterRuntimeInit());
    this.watchdogCancel = this.timerRuntime.scheduleRecurring(WATCHDOG_NAME, { periodMinutes: 1 }, async () => {
      const watchdogStartedAt = this.clock();
      this.hostLogger.debug?.("desktop_watchdog_started", {});
      try {
        await this.schedulerEngine.tick({ reason: "desktop_watchdog" });
        await this.integrationEngine.tick({ reason: "desktop_watchdog" });
        await this.recoveryController.tick({ reason: "desktop_watchdog" });
        this.hostLogger.debug?.("desktop_watchdog_completed", {
          durationMs: Math.max(0, this.clock() - watchdogStartedAt)
        });
      } catch (error) {
        this.hostLogger.error?.("desktop_watchdog_failed", {
          durationMs: Math.max(0, this.clock() - watchdogStartedAt),
          error
        });
        throw error;
      }
    });
    this.initialized = true;
    this.hostLogger.info?.("desktop_host_ready", {
      apiVersion: this.root.ORCHESTRATOR_API_VERSION,
      durationMs: Math.max(0, hostNow(this) - startedAt)
    });
    return this.query("state");
  }

  async query(name, payload = {}) {
    if (!this.initialized) throw new Error("desktop_host_not_initialized");
    const queryName = String(name || "");
    return this.traceApiCall("query", queryName, payload, async () => jsonClone(await this.orchestratorApi.query(queryName, payload)));
  }

  async execute(name, payload = {}) {
    if (!this.initialized) throw new Error("desktop_host_not_initialized");
    const command = String(name || "");
    return this.traceApiCall("command", command, payload, async () => {
      const result = await this.orchestratorApi.execute(command, payload);
      if (result?.ok && command === "startProject") {
        const projectId = this.projectStore.getActiveProject()?.projectId;
        if (projectId) await this.recoveryController.attachProject(projectId, "project_started");
      }
      if (result?.ok && command === "startExecution") {
        const projectId = this.projectStore.getActiveProject()?.projectId;
        if (projectId && this.recoveryStore.summary().projectId !== projectId) await this.recoveryController.attachProject(projectId, "execution_started");
      }
      if (result?.ok && ["startExecution", "resume", "createWorkers"].includes(command)) await this.readyFakeWorkers(command);
      if (!(command === "importProjectBundle" && result?.ok && result?.reloadRequired)) await this.recoveryController.tick({ reason: `desktop_api:${command || "unknown"}` });
      return jsonClone(result);
    });
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    const startedAt = this.clock();
    this.hostLogger.info?.("desktop_host_closing", {});
    try { await this.watchdogCancel?.(); } catch (error) {
      this.hostLogger.warn?.("desktop_watchdog_cancel_failed", { error });
    }
    if (this.ownsTimerRuntime) await this.timerRuntime.close?.();
    if (this.ownsStateStore) this.stateStore.close?.();
    this.hostLogger.info?.("desktop_host_closed", {
      durationMs: Math.max(0, hostNow(this) - startedAt)
    });
  }
}

async function createDesktopHost(options = {}) {
  const host = new DesktopHost(options);
  await host.init();
  return host;
}

module.exports = { DesktopHost, createDesktopHost, WATCHDOG_NAME };
