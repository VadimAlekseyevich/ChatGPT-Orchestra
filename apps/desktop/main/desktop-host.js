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
const { SQLiteStateStore } = require("../../../platform/sqlite-state-store.js");
const { FakeAgentRuntime } = require("../../../platform/fake-runtime.js");
const { NodeTimerRuntime } = require("../../../platform/node-timer-runtime.js");

const WATCHDOG_NAME = "orchestra-desktop-watchdog";
const REPOSITORY_BOUNDARY_COMMANDS = new Set(["resume", "startExecution", "startIntegration"]);

function jsonClone(value) {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value));
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
    autoSeedFakeLead = true
  } = {}) {
    this.root = loadDesktopCore();
    this.paths = paths || ensureDesktopPaths({ dataDirectory });
    this.logger = logger || new StructuredLogger({ filename: this.paths.logFile, clock });
    this.clock = clock;
    this.ownsStateStore = !stateStore;
    this.ownsTimerRuntime = !timerRuntime;
    this.persistenceBackend = stateStore ? "injected" : "sqlite";
    this.stateStore = stateStore || new SQLiteStateStore({ filename: this.paths.stateDatabase, clock });
    this.agentRuntime = agentRuntime || new FakeAgentRuntime({ clock });
    this.timerRuntime = timerRuntime || new NodeTimerRuntime({ logger: this.logger });
    this.repositoryService = repositoryService || new DesktopRepositoryService({ stateStore: this.stateStore, paths: this.paths, clock, logger: this.logger });
    this.remoteGitProvider = gitProvider || new this.root.GitProvider.GitHubRestProvider({ logger: this.logger, clock });
    this.gitProvider = new LocalValidatingGitProvider({ remoteProvider: this.remoteGitProvider, repositoryService: this.repositoryService, logger: this.logger });
    this.localIntegrationCoordinator = new LocalIntegrationCoordinator({ repositoryService: this.repositoryService, clock, logger: this.logger });
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
    this.eventBus = new root.EventBus({ registry: this.agentRuntime, store: this.eventStore });
    this.projectStore = new root.ProjectStore({ storageArea: this.stateStore });
    this.schedulerStore = new root.SchedulerStore({ storageArea: this.stateStore });
    this.reviewStore = new root.ReviewStore({ storageArea: this.stateStore });
    this.integrationStore = new root.IntegrationStore({ storageArea: this.stateStore });
    this.recoveryStore = new root.RecoveryStore({ storageArea: this.stateStore });
    this.contextStore = new root.ContextStore({ storageArea: this.stateStore });

    this.migrationRegistry = new root.MigrationRegistry({ currentVersion: root.PortableState.PORTABLE_SCHEMA_VERSION });
    this.portableStateManager = new root.PortableState.PortableStateManager({ stateStore: this.stateStore, migrations: this.migrationRegistry });
    this.projectBundleService = new root.ProjectBundle.ProjectBundleService({ portableStateManager: this.portableStateManager, sourceHost: "desktop-node" });
    this.persistenceInfo = () => ({ backend: this.persistenceBackend, transactional: true, host: "desktop-node" });

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
      logger: this.logger
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
      logger: this.logger
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

  async sendWorkerPromptWithWorkspace(agentId, prompt) {
    const agent = this.agentRuntime.getAgent?.(agentId) || null;
    const context = agent?.protocolContext || null;
    const run = context?.runId ? this.schedulerStore.getRun?.(context.runId) : null;
    const taskState = context?.taskId ? this.schedulerStore.getTask?.(context.taskId) : null;
    const project = this.projectStore.getActiveProject?.() || null;
    if (run && taskState && project && this.gitProvider?.prepareRun) {
      const task = taskState.definition || taskState;
      const prepared = await this.gitProvider.prepareRun({ project, task, run, snapshot: this.schedulerStore.getGitSnapshot?.() || null });
      if (!prepared?.ok) return { ok: false, reason: "local_workspace_prepare_failed", details: { reason: prepared?.reason || "unknown", runId: run.runId, taskId: task.id } };
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
    return this.agentRuntime.sendPrompt(agentId, prompt);
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

  async localRepositoryBindingState() {
    const project = this.projectStore.getActiveProject?.() || null;
    const repositoryId = project?.repositoryRuntime?.repositoryId || null;
    if (!repositoryId) return { ok: true, required: false, projectId: project?.projectId || null };
    const linked = await this.repositoryService.getRepository(repositoryId);
    if (linked?.ok) return { ok: true, required: true, projectId: project.projectId, repositoryId, repository: linked.repository };
    return {
      ok: false,
      reason: "repository_rebind_required",
      projectId: project.projectId,
      repositoryId,
      repositoryUrl: project.repository?.url || null
    };
  }

  async init() {
    if (this.closed) throw new Error("desktop_host_closed");
    if (this.initialized) return this.query("state");
    this.logger.info?.("desktop_host_starting", { backend: this.persistenceBackend });
    await this.seedFakeLead();
    await this.contextPackets.init();
    await this.recoveryController.prepareForBoot();
    await this.orchestrator.init();
    await this.integrationEngine.init();
    await this.recoveryController.afterRuntimeInit();
    const binding = await this.localRepositoryBindingState();
    if (!binding.ok) this.logger.warn?.("desktop_repository_rebind_required", { projectId: binding.projectId, repositoryId: binding.repositoryId });
    this.watchdogCancel = this.timerRuntime.scheduleRecurring(WATCHDOG_NAME, { periodMinutes: 1 }, async () => {
      await this.schedulerEngine.tick({ reason: "desktop_watchdog" });
      await this.integrationEngine.tick({ reason: "desktop_watchdog" });
      await this.recoveryController.tick({ reason: "desktop_watchdog" });
    });
    this.initialized = true;
    this.logger.info?.("desktop_host_ready", { apiVersion: this.root.ORCHESTRATOR_API_VERSION });
    return this.query("state");
  }

  async query(name, payload = {}) {
    if (!this.initialized) throw new Error("desktop_host_not_initialized");
    return jsonClone(await this.orchestratorApi.query(name, payload));
  }

  async execute(name, payload = {}) {
    if (!this.initialized) throw new Error("desktop_host_not_initialized");
    const command = String(name || "");
    if (REPOSITORY_BOUNDARY_COMMANDS.has(command)) {
      const binding = await this.localRepositoryBindingState();
      if (!binding.ok) return jsonClone({ apiVersion: this.root.ORCHESTRATOR_API_VERSION, ...binding });
    }
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
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    try { await this.watchdogCancel?.(); } catch (_) {}
    if (this.ownsTimerRuntime) await this.timerRuntime.close?.();
    if (this.ownsStateStore) this.stateStore.close?.();
    this.logger.info?.("desktop_host_closed", {});
  }
}

async function createDesktopHost(options = {}) {
  const host = new DesktopHost(options);
  await host.init();
  return host;
}

module.exports = { DesktopHost, createDesktopHost, WATCHDOG_NAME, REPOSITORY_BOUNDARY_COMMANDS };
