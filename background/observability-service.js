(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};
  const OBSERVABILITY_VERSION = 1;
  const MAX_TEXT = 4000;
  const MAX_WARNINGS = 200;
  const RUNTIME_KEYS = new Set(["tabId", "legacyTabId", "sessionId", "runtimeSource"]);

  function clone(value) {
    if (typeof structuredClone === "function") return structuredClone(value);
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
  }

  function sanitize(value) {
    if (Array.isArray(value)) return value.map(sanitize);
    if (!value || typeof value !== "object") return value;
    const output = {};
    for (const [key, item] of Object.entries(value)) {
      if (RUNTIME_KEYS.has(key)) continue;
      if (key === "runtime" && item && typeof item === "object" && (item.sessionId !== undefined || item.legacyTabId !== undefined || item.tabId !== undefined)) continue;
      output[key] = sanitize(item);
    }
    return output;
  }

  function text(value, max = MAX_TEXT) {
    const result = String(value ?? "");
    return result.length > max ? `${result.slice(0, max)}…` : result;
  }

  function number(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function severityRank(value) {
    return ({ info: 0, warning: 1, error: 2, critical: 3 })[String(value || "info").toLowerCase()] ?? 0;
  }

  function warning(id, severity, code, message, details = null, at = 0) {
    return sanitize({
      id: String(id || code || "warning"),
      severity: String(severity || "warning"),
      code: String(code || "warning"),
      message: text(message, 1500),
      details: details && typeof details === "object" ? clone(details) : null,
      at: number(at)
    });
  }

  function runPublic(run) {
    if (!run) return null;
    return sanitize({
      runId: String(run.runId || ""),
      taskId: String(run.taskId || ""),
      agentId: run.agentId ? String(run.agentId) : null,
      status: String(run.status || "UNKNOWN"),
      attempt: number(run.attempt),
      locks: clone(run.locks || []),
      git: run.git ? {
        required: run.git.required !== false,
        provider: String(run.git.provider || ""),
        branch: String(run.git.branch || ""),
        targetBranch: String(run.git.targetBranch || ""),
        baseSha: String(run.git.baseSha || ""),
        startSha: String(run.git.startSha || ""),
        artifactStatus: String(run.git.artifactStatus || "PENDING"),
        artifact: run.git.artifact ? clone(run.git.artifact) : null,
        validation: run.git.validation ? clone(run.git.validation) : null
      } : null,
      assignedAt: number(run.assignedAt),
      startedAt: number(run.startedAt),
      lastEventAt: number(run.lastEventAt),
      finishedAt: number(run.finishedAt),
      failureReason: run.failureReason ? String(run.failureReason) : null
    });
  }

  function taskPublic(task, schedulerStore) {
    const activeRun = task?.activeRunId ? schedulerStore?.getRun?.(task.activeRunId) : null;
    const lastRun = task?.lastRunId ? schedulerStore?.getRun?.(task.lastRunId) : null;
    const dependencies = Array.isArray(task?.dependencies) ? [...task.dependencies] : [];
    const blockers = dependencies.filter((taskId) => schedulerStore?.getTask?.(taskId)?.status !== "APPROVED");
    return sanitize({
      taskId: String(task?.id || ""),
      title: text(task?.title || task?.id || "", 300),
      objective: text(task?.objective || "", 1600),
      kind: String(task?.kind || "code"),
      status: String(task?.status || "UNKNOWN"),
      dependencies,
      blockers,
      priority: number(task?.priority),
      risk: String(task?.risk || "medium"),
      estimatedComplexity: String(task?.estimatedComplexity || "M"),
      scope: clone(task?.scope || {}),
      acceptanceCriteria: clone(task?.acceptanceCriteria || []),
      verification: clone(task?.verification || []),
      attempts: number(task?.attempts),
      reviewIterations: number(task?.reviewIterations),
      activeRunId: task?.activeRunId || null,
      activeReviewId: task?.activeReviewId || null,
      lastRunId: task?.lastRunId || null,
      lastArtifact: task?.lastArtifact ? clone(task.lastArtifact) : null,
      lastReview: task?.lastReview ? clone(task.lastReview) : null,
      lastError: task?.lastError ? clone(task.lastError) : null,
      reworkContext: task?.reworkContext ? clone(task.reworkContext) : null,
      activeRun: activeRun ? runPublic(activeRun) : null,
      lastRun: lastRun ? runPublic(lastRun) : null,
      controls: {
        canRetry: task?.status === "NEEDS_USER" && !task?.activeRunId && !task?.activeReviewId,
        canCancel: ["READY", "NEEDS_USER"].includes(String(task?.status || "")) && !task?.activeRunId && !task?.activeReviewId,
        canChangePriority: ["READY", "NEEDS_USER"].includes(String(task?.status || "")) && !task?.activeRunId,
        canReassign: ["READY", "NEEDS_USER"].includes(String(task?.status || "")) && !task?.activeRunId && !task?.activeReviewId,
        canRequestReview: ["DONE_BY_WORKER", "REVIEW_PENDING"].includes(String(task?.status || ""))
      },
      updatedAt: number(task?.updatedAt)
    });
  }

  function reviewPublic(review) {
    if (!review) return null;
    return sanitize({
      reviewId: String(review.reviewId || ""),
      taskId: String(review.taskId || ""),
      workerRunId: String(review.workerRunId || ""),
      authorAgentId: review.authorAgentId ? String(review.authorAgentId) : null,
      reviewerAgentId: review.reviewerAgentId ? String(review.reviewerAgentId) : null,
      iteration: number(review.iteration, 1),
      retryOf: review.retryOf || null,
      status: String(review.status || "UNKNOWN"),
      result: review.result ? clone(review.result) : null,
      lastError: review.lastError ? String(review.lastError) : null,
      assignedAt: number(review.assignedAt),
      startedAt: number(review.startedAt),
      completedAt: number(review.completedAt),
      createdAt: number(review.createdAt),
      updatedAt: number(review.updatedAt)
    });
  }

  function integrationRunPublic(run) {
    if (!run) return null;
    return sanitize({
      runId: String(run.runId || ""),
      agentId: run.agentId ? String(run.agentId) : null,
      status: String(run.status || "UNKNOWN"),
      branch: String(run.branch || ""),
      baseSha: String(run.baseSha || ""),
      targetBranch: String(run.targetBranch || ""),
      taskOrder: clone(run.taskOrder || []),
      mergeTaskIds: clone(run.mergeTaskIds || []),
      artifacts: clone(run.artifacts || []),
      verificationCommands: clone(run.verificationCommands || []),
      repairAttempts: number(run.repairAttempts),
      activeRepairTaskId: run.activeRepairTaskId || null,
      lastConflict: run.lastConflict ? clone(run.lastConflict) : null,
      result: run.result ? clone(run.result) : null,
      failureReason: run.failureReason ? String(run.failureReason) : null,
      assignedAt: number(run.assignedAt),
      startedAt: number(run.startedAt),
      lastEventAt: number(run.lastEventAt),
      finishedAt: number(run.finishedAt),
      createdAt: number(run.createdAt),
      updatedAt: number(run.updatedAt)
    });
  }

  class ObservabilityService {
    constructor({ projectStore, schedulerStore, reviewStore, integrationStore, registry, eventBus, recoveryController, persistenceInfo = null, clock = () => Date.now() } = {}) {
      this.projectStore = projectStore;
      this.schedulerStore = schedulerStore;
      this.reviewStore = reviewStore;
      this.integrationStore = integrationStore;
      this.registry = registry;
      this.eventBus = eventBus;
      this.recoveryController = recoveryController;
      this.persistenceInfo = persistenceInfo;
      this.clock = clock;
    }

    agents() {
      return (this.registry?.listAgents?.() || []).map((agent) => ({
        agentId: String(agent.agentId || ""),
        role: String(agent.role || "worker"),
        label: text(agent.label || "", 300),
        status: String(agent.status || "UNKNOWN"),
        connected: Boolean(this.registry?.isAgentConnected?.(agent)),
        lastSeenAt: number(agent.lastSeenAt),
        lastError: agent.lastError ? text(agent.lastError, 1000) : null,
        activeContext: sanitize(agent.protocolContext ? clone(agent.protocolContext) : null),
        capabilities: sanitize(clone(agent.capabilities || [])),
        executorRef: { agentId: String(agent.agentId || "") }
      }));
    }

    warnings({ minimumSeverity = "info" } = {}) {
      const project = this.projectStore?.getActiveProject?.() || null;
      const tasks = this.schedulerStore?.listTasks?.() || [];
      const reviews = this.reviewStore?.list?.() || [];
      const integration = this.integrationStore?.summary?.() || null;
      const recovery = this.recoveryController?.getPublicState?.() || null;
      const agents = this.agents();
      const recent = this.eventBus?.recent?.(100) || { rejections: [] };
      const output = [];

      if (project?.lastError) output.push(warning(`project:${project.projectId}`, "error", project.lastError.reason || "project_error", project.lastError.reason || "Project needs attention", project.lastError.details || null, project.lastError.at));
      for (const issue of recovery?.issues || []) output.push(warning(`recovery:${issue.code || output.length}`, "error", issue.code || "recovery_issue", issue.message || issue.code || "Recovery issue", issue, issue.at || recovery.updatedAt));
      for (const task of tasks) {
        if (task.status === "NEEDS_USER") output.push(warning(`task:${task.id}:needs-user`, "error", task.lastError?.reason || "task_needs_user", `${task.title || task.id} needs user`, { taskId: task.id, lastError: task.lastError || null }, task.updatedAt));
        else if (task.lastError) output.push(warning(`task:${task.id}:last-error`, "warning", task.lastError.reason || "task_error", `${task.title || task.id}: ${task.lastError.reason || "error"}`, { taskId: task.id }, task.lastError.at || task.updatedAt));
      }
      for (const review of reviews) {
        if (review.status === "FAILED") output.push(warning(`review:${review.reviewId}`, "error", review.lastError || "review_failed", `Review ${review.reviewId} failed`, { reviewId: review.reviewId, taskId: review.taskId }, review.completedAt || review.updatedAt));
        else if (review.status === "CHANGES_REQUIRED") output.push(warning(`review:${review.reviewId}`, "warning", "changes_required", `Changes required for ${review.taskId}`, { reviewId: review.reviewId, taskId: review.taskId }, review.completedAt));
      }
      if (["NEEDS_USER", "CONFLICT"].includes(String(integration?.status || ""))) output.push(warning(`integration:${integration?.currentRunId || "current"}`, "error", `integration_${String(integration.status).toLowerCase()}`, `Integration is ${integration.status}`, integration, integration.updatedAt));
      for (const agent of agents) {
        if (!agent.connected) output.push(warning(`agent:${agent.agentId}:offline`, agent.role === "lead" ? "error" : "warning", "agent_offline", `${agent.label || agent.agentId} is offline`, { agentId: agent.agentId, role: agent.role }, agent.lastSeenAt));
        else if (agent.status === "ERROR") output.push(warning(`agent:${agent.agentId}:error`, "warning", "agent_error", `${agent.label || agent.agentId} reports ERROR`, { agentId: agent.agentId }, agent.lastSeenAt));
      }
      for (const rejection of recent.rejections || []) output.push(warning(`event-rejection:${rejection.cursor || rejection.at || output.length}`, "warning", rejection.reason || "event_rejected", `Protocol event rejected: ${rejection.reason || "unknown"}`, { event: sanitize(rejection.event || null) }, rejection.receivedAt || rejection.at));

      const minRank = severityRank(minimumSeverity);
      return output.filter((item) => severityRank(item.severity) >= minRank).sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || number(b.at) - number(a.at)).slice(0, MAX_WARNINGS);
    }

    metrics() {
      const tasks = this.schedulerStore?.listTasks?.() || [];
      const reviews = this.reviewStore?.list?.() || [];
      const agents = this.agents();
      const runs = this.schedulerStore?.listRuns?.() || [];
      const statusCounts = {};
      for (const task of tasks) statusCounts[task.status] = (statusCounts[task.status] || 0) + 1;
      const approved = statusCounts.APPROVED || 0;
      const cancelled = statusCounts.CANCELLED || 0;
      const finished = approved + cancelled;
      const durations = runs.filter((run) => run.startedAt && run.finishedAt && run.finishedAt >= run.startedAt).map((run) => run.finishedAt - run.startedAt);
      return {
        tasks: { total: tasks.length, approved, cancelled, finished, progress: tasks.length ? finished / tasks.length : 0, byStatus: statusCounts },
        runs: { total: runs.length, active: runs.filter((run) => ["ASSIGNED", "RUNNING"].includes(run.status)).length, averageDurationMs: durations.length ? Math.round(durations.reduce((sum, item) => sum + item, 0) / durations.length) : 0 },
        reviews: { total: reviews.length, active: reviews.filter((item) => ["ASSIGNED", "REVIEWING"].includes(item.status)).length, approved: reviews.filter((item) => item.status === "APPROVED").length, changesRequired: reviews.filter((item) => item.status === "CHANGES_REQUIRED").length },
        agents: { total: agents.length, connected: agents.filter((item) => item.connected).length, busy: agents.filter((item) => item.status === "BUSY").length, idle: agents.filter((item) => item.status === "IDLE").length, offline: agents.filter((item) => !item.connected).length },
        updatedAt: this.clock()
      };
    }

    task(taskId) {
      const task = this.schedulerStore?.getTask?.(taskId);
      return task ? taskPublic(task, this.schedulerStore) : null;
    }

    dashboard({ eventLimit = 60, decisionLimit = 60, minimumSeverity = "info" } = {}) {
      const project = this.projectStore?.getActiveProject?.() || null;
      const scheduler = this.schedulerStore?.summary?.() || null;
      const tasks = (this.schedulerStore?.listTasks?.() || []).map((task) => taskPublic(task, this.schedulerStore));
      const reviews = (this.reviewStore?.list?.() || []).map(reviewPublic);
      const integration = this.integrationStore?.summary?.() || null;
      const integrationRuns = (this.integrationStore?.listRuns?.() || []).map(integrationRunPublic);
      const repairs = sanitize(clone(this.integrationStore?.listRepairs?.() || []));
      const recovery = sanitize(this.recoveryController?.getPublicState?.() || null);
      const recent = this.eventBus?.recent?.(eventLimit) || { events: [], rejections: [] };
      const events = sanitize(clone(recent.events || []));
      const rejections = sanitize(clone(recent.rejections || []));
      const decisions = sanitize(clone(this.schedulerStore?.recentDecisions?.(decisionLimit) || []));
      const persistence = sanitize(typeof this.persistenceInfo === "function" ? this.persistenceInfo() : (this.persistenceInfo || {}));
      const timestamps = [project?.updatedAt, scheduler?.updatedAt, integration?.updatedAt, recovery?.updatedAt, ...tasks.map((item) => item.updatedAt), ...reviews.map((item) => item.updatedAt)].map(number);
      const revision = Math.max(0, ...timestamps, number(events.at?.(-1)?.receivedAt), number(rejections.at?.(-1)?.receivedAt));

      const dto = {
        observabilityVersion: OBSERVABILITY_VERSION,
        revision,
        generatedAt: this.clock(),
        project: project ? sanitize({ projectId: project.projectId, status: project.status, stage: project.stage, goal: text(project.initialGoal || "", 12000), repository: clone(project.repository || null), validation: clone(project.validation || null), execution: clone(project.execution || null), lastError: project.lastError ? clone(project.lastError) : null, createdAt: number(project.createdAt), updatedAt: number(project.updatedAt) }) : null,
        scheduler: sanitize(scheduler),
        tasks,
        activeRuns: tasks.map((item) => item.activeRun).filter(Boolean),
        reviews: { summary: sanitize(this.reviewStore?.summary?.() || null), items: reviews },
        integration: { summary: sanitize(integration), runs: integrationRuns, repairs },
        recovery,
        agents: this.agents(),
        decisions,
        events,
        rejections,
        warnings: this.warnings({ minimumSeverity }),
        metrics: this.metrics(),
        persistence: { portableSchemaVersion: root.PortableState?.PORTABLE_SCHEMA_VERSION || 1, bundleVersion: root.ProjectBundle?.BUNDLE_VERSION || 1, ...persistence }
      };
      return sanitize(dto);
    }

    debugBundle(options = {}) {
      const dashboard = this.dashboard({ eventLimit: options.eventLimit || 200, decisionLimit: options.decisionLimit || 200, minimumSeverity: "info" });
      const payload = sanitize({ format: "chatgpt-orchestra-debug-bundle", version: 1, generatedAt: this.clock(), dashboard });
      const serialized = JSON.stringify(payload, null, 2);
      return { ok: true, filename: `chatgpt-orchestra-debug-${dashboard.project?.projectId || "no-project"}.json`, bytes: new TextEncoder().encode(serialized).length, serialized, payload };
    }
  }

  root.ObservabilityService = ObservabilityService;
  root.OBSERVABILITY_VERSION = OBSERVABILITY_VERSION;
  if (typeof module !== "undefined" && module.exports) module.exports = { ObservabilityService, OBSERVABILITY_VERSION, sanitize, taskPublic, runPublic, reviewPublic, integrationRunPublic };
})();
