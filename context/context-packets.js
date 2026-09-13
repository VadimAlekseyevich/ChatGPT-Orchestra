(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};
  const PACKET_VERSION = 1;
  const BUDGET_POLICY_VERSION = 1;
  const BUDGETS = Object.freeze({ lead: 24000, task: 26000, review: 36000, integration: 36000, repair: 32000 });
  const RUNTIME_KEYS = new Set(["tabId", "legacyTabId", "sessionId", "runtimeSource", "browserHandle", "pageId", "webContentsId"]);
  const TRANSCRIPT_KEYS = new Set(["transcript", "chatHistory", "conversationHistory", "messages", "rawResponse", "rawTranscript"]);

  function clone(value) {
    if (typeof structuredClone === "function") return structuredClone(value);
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
  }

  function text(value, max = 3000) {
    const output = String(value ?? "");
    return output.length > max ? `${output.slice(0, Math.max(0, max - 1))}…` : output;
  }

  function capArray(value, max = 24) {
    if (!Array.isArray(value)) return [];
    return value.slice(0, max).map((item) => clone(item));
  }

  function compactValue(value, depth = 0) {
    if (value === null || value === undefined) return value;
    if (typeof value === "string") return text(value, depth < 2 ? 4000 : 1800);
    if (["number", "boolean"].includes(typeof value)) return value;
    if (Array.isArray(value)) {
      const max = depth < 2 ? 24 : 12;
      const output = value.slice(0, max).map((item) => compactValue(item, depth + 1));
      if (value.length > max) output.push({ _truncatedItems: value.length - max });
      return output;
    }
    if (typeof value === "object") {
      const output = {};
      let count = 0;
      for (const [key, item] of Object.entries(value)) {
        if (RUNTIME_KEYS.has(key) || TRANSCRIPT_KEYS.has(key)) continue;
        if (key === "runtime" && item && typeof item === "object") continue;
        output[key] = compactValue(item, depth + 1);
        count += 1;
        if (count >= 30) {
          output._truncatedFields = Math.max(0, Object.keys(value).length - count);
          break;
        }
      }
      return output;
    }
    return text(value, 1000);
  }

  function byteLength(value) {
    const serialized = typeof value === "string" ? value : JSON.stringify(value);
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(serialized).length;
    if (typeof Buffer !== "undefined") return Buffer.byteLength(serialized, "utf8");
    return serialized.length;
  }

  function collectLongStrings(node, path = [], output = []) {
    if (!node || typeof node !== "object") return output;
    if (Array.isArray(node)) {
      node.forEach((item, index) => {
        if (typeof item === "string" && item.length > 256) output.push({ parent: node, key: index, path: [...path, index], length: item.length });
        else collectLongStrings(item, [...path, index], output);
      });
      return output;
    }
    for (const [key, item] of Object.entries(node)) {
      if (typeof item === "string" && item.length > 256) output.push({ parent: node, key, path: [...path, key], length: item.length });
      else collectLongStrings(item, [...path, key], output);
    }
    return output;
  }

  function enforceBudget(packet, packetType) {
    const maxChars = Number(BUDGETS[packetType] || 24000);
    const output = compactValue(packet);
    const truncatedFields = [];
    let bytes = byteLength(output);
    let guard = 0;
    while (bytes > maxChars && guard < 128) {
      const candidates = collectLongStrings(output).sort((a, b) => b.length - a.length);
      const candidate = candidates[0];
      if (!candidate) break;
      const current = String(candidate.parent[candidate.key]);
      const nextLength = Math.max(240, Math.floor(current.length * 0.6));
      candidate.parent[candidate.key] = `${current.slice(0, nextLength)}…`;
      truncatedFields.push(candidate.path.join("."));
      bytes = byteLength(output);
      guard += 1;
    }
    if (bytes > maxChars) {
      for (const optional of ["decisions", "completedTasks", "repositoryContext"]) {
        if (output[optional] !== undefined) {
          output[optional] = Array.isArray(output[optional]) ? [] : { omittedForBudget: true };
          truncatedFields.push(optional);
          bytes = byteLength(output);
          if (bytes <= maxChars) break;
        }
      }
    }
    output.budget = {
      policyVersion: BUDGET_POLICY_VERSION,
      maxChars,
      chars: byteLength(output),
      withinBudget: byteLength(output) <= maxChars,
      truncated: truncatedFields.length > 0,
      truncatedFields: [...new Set(truncatedFields)].slice(0, 40)
    };
    return output;
  }

  function artifactRef(task) {
    const artifact = task?.lastArtifact || task?.git?.artifact || null;
    if (!artifact) return null;
    return compactValue({
      kind: "git_artifact",
      taskId: task.id || task.taskId || null,
      branch: artifact.branch || null,
      commit: artifact.commit || null,
      baseSha: artifact.baseSha || null,
      targetBranch: artifact.targetBranch || null,
      changedFiles: capArray(artifact.changedFiles, 40),
      validation: artifact.validation || null
    });
  }

  function compactReview(task) {
    const review = task?.lastReview || null;
    if (!review) return null;
    return compactValue({
      status: review.status || review.outcome || null,
      summary: text(review.summary || "", 1200),
      issues: capArray(review.issues, 8),
      requiredChanges: capArray(review.requiredChanges, 8)
    });
  }

  function compactTask(task) {
    return compactValue({
      taskId: task?.id || task?.taskId || null,
      title: text(task?.title || task?.definition?.title || "", 240),
      objective: text(task?.objective || task?.definition?.objective || "", 800),
      status: task?.status || null,
      dependencies: capArray(task?.dependencies || task?.definition?.dependencies, 20),
      acceptanceCriteria: capArray(task?.acceptanceCriteria || task?.definition?.acceptanceCriteria, 16),
      verification: capArray(task?.verification || task?.definition?.verification, 12),
      artifactRef: artifactRef(task),
      review: compactReview(task),
      lastError: task?.lastError ? compactValue(task.lastError) : null
    });
  }

  function relevantModules(discovery, task) {
    const modules = Array.isArray(discovery?.modules) ? discovery.modules.map(String) : [];
    const allow = Array.isArray(task?.scope?.allow) ? task.scope.allow.map(String) : [];
    if (!allow.length) return modules.slice(0, 18);
    const roots = allow.map((item) => item.replace(/[*?].*$/, "").replace(/^\.\//, "")).filter(Boolean);
    const filtered = modules.filter((modulePath) => roots.some((rootPath) => modulePath.startsWith(rootPath) || rootPath.startsWith(modulePath)));
    return (filtered.length ? filtered : modules).slice(0, 18);
  }

  function repositoryContext(project, task = null) {
    const discovery = project?.artifacts?.DISCOVERY || {};
    const plan = project?.artifacts?.PLAN_V2 || {};
    return compactValue({
      stack: capArray(discovery.stack, 18),
      entrypoints: capArray(discovery.entrypoints, 18),
      commands: discovery.commands || {},
      modules: relevantModules(discovery, task),
      instructions: discovery.repositoryInstructions || discovery.instructions || null,
      architectureRules: plan.architectureRules || discovery.architectureRules || null,
      sensitiveAreas: capArray(discovery.sensitiveAreas, 12),
      constraints: capArray(discovery.constraints, 16)
    });
  }

  function promptVersion(role) {
    if (role === "lead") return Number(root.PlanningPrompts?.PROMPT_VERSION) || 1;
    if (role === "worker") return Number(root.WorkerPrompts?.PROMPT_VERSION) || 1;
    if (role === "reviewer") return Number(root.ReviewPrompts?.PROMPT_VERSION) || 1;
    if (role === "integrator") return Number(root.IntegrationPrompts?.PROMPT_VERSION) || 1;
    return 1;
  }

  function planningInputs(project, stage) {
    const artifacts = project?.artifacts || {};
    const refs = [];
    const names = stage === "PLAN_V1" ? ["DISCOVERY"]
      : stage === "CRITIQUE" ? ["DISCOVERY", "PLAN_V1"]
      : stage === "PLAN_V2" ? ["DISCOVERY", "PLAN_V1", "CRITIQUE"]
      : stage === "DECOMPOSE" ? ["DISCOVERY", "PLAN_V2"]
      : stage === "DAG_CRITIC" ? ["PLAN_V2", "DECOMPOSE"]
      : [];
    const inputs = {};
    for (const name of names) {
      if (artifacts[name] === undefined) continue;
      refs.push({ kind: "planning_artifact", stage: name, ref: `project.artifacts.${name}` });
      inputs[name] = compactValue(artifacts[name]);
    }
    return { refs, inputs };
  }

  class ContextPacketService {
    constructor({ contextStore = null, projectStore, schedulerStore = null, reviewStore = null, integrationStore = null, recoveryStore = null, clock = () => Date.now() } = {}) {
      this.contextStore = contextStore;
      this.projectStore = projectStore;
      this.schedulerStore = schedulerStore;
      this.reviewStore = reviewStore;
      this.integrationStore = integrationStore;
      this.recoveryStore = recoveryStore;
      this.clock = clock;
    }

    async init() {
      await this.contextStore?.load?.();
      const project = this.projectStore?.getActiveProject?.();
      if (project) this.refreshPersistedContext(project);
      return this.contextStore?.summary?.() || null;
    }

    decisionRegister(project) {
      const decisions = [];
      for (const entry of project?.stageHistory || []) {
        decisions.push({
          decisionId: `planning:${entry.stage}:${entry.runId}:${entry.status}`,
          source: "planning",
          type: `planning_stage_${entry.status}`,
          at: Number(entry.at) || 0,
          details: { stage: entry.stage, runId: entry.runId }
        });
      }
      for (const [index, item] of (this.schedulerStore?.recentDecisions?.(100) || []).entries()) {
        decisions.push({
          decisionId: `scheduler:${Number(item.at) || 0}:${index}:${item.type || "decision"}`,
          source: "scheduler",
          type: String(item.type || "decision"),
          at: Number(item.at) || 0,
          details: compactValue(item.details || null)
        });
      }
      return decisions.sort((a, b) => a.at - b.at).slice(-120);
    }

    completedTasks() {
      return (this.schedulerStore?.listTasks?.() || [])
        .filter((task) => ["APPROVED", "CANCELLED"].includes(String(task.status || "")))
        .slice(-24)
        .map(compactTask);
    }

    leadSummary(project) {
      const tasks = this.schedulerStore?.listTasks?.() || [];
      const byStatus = {};
      for (const task of tasks) byStatus[task.status] = (byStatus[task.status] || 0) + 1;
      const activeRuns = this.schedulerStore?.activeRuns?.() || [];
      const activeReviews = this.reviewStore?.active?.() || [];
      const integration = this.integrationStore?.summary?.() || null;
      const recovery = this.recoveryStore?.summary?.() || null;
      return compactValue({
        summaryVersion: 1,
        projectId: project.projectId,
        repository: project.repository || null,
        immutableGoal: text(project.initialGoal || "", 5000),
        status: project.status,
        stage: project.stage,
        taskProgress: { total: tasks.length, byStatus },
        activeRoles: {
          workerRuns: activeRuns.map((run) => ({ taskId: run.taskId, runId: run.runId, agentId: run.agentId, status: run.status })),
          reviews: activeReviews.map((review) => ({ taskId: review.taskId, reviewId: review.reviewId, reviewerAgentId: review.reviewerAgentId, status: review.status })),
          integration: integration ? { status: integration.status, currentRunId: integration.currentRunId || null } : null
        },
        completedTasks: this.completedTasks(),
        recovery: recovery ? { status: recovery.status, reason: recovery.reason || null, issues: capArray(recovery.issues, 8) } : null,
        artifactRefs: Object.keys(project.artifacts || {}).map((stage) => ({ kind: "planning_artifact", stage, ref: `project.artifacts.${stage}` })),
        generatedAt: this.clock()
      });
    }

    refreshPersistedContext(project) {
      if (!project?.projectId || !this.contextStore) return;
      const leadSummary = this.leadSummary(project);
      const decisions = this.decisionRegister(project);
      this.contextStore.updateContextInMemory?.(project.projectId, { leadSummary, decisions });
      Promise.resolve(this.contextStore.persist?.()).catch(() => {});
    }

    basePacket({ packetType, role, project, logicalRoleId, identity = null }) {
      this.refreshPersistedContext(project);
      return {
        packetVersion: PACKET_VERSION,
        packetType,
        logicalRole: { role, logicalRoleId },
        identity: compactValue(identity),
        project: {
          projectId: project.projectId,
          repository: compactValue(project.repository || null),
          immutableGoal: text(project.initialGoal || "", 5000),
          status: project.status,
          stage: project.stage
        },
        leadSummary: this.contextStore?.state?.leadSummary || this.leadSummary(project),
        decisions: (this.contextStore?.state?.decisions || this.decisionRegister(project)).slice(-30),
        completedTasks: this.completedTasks(),
        provenance: {
          packetVersion: PACKET_VERSION,
          budgetPolicyVersion: BUDGET_POLICY_VERSION,
          promptContractVersion: promptVersion(role),
          generatedFromPersistedState: true,
          transcriptCopied: false
        },
        generatedAt: this.clock()
      };
    }

    finalize(packet, type) {
      const output = enforceBudget(packet, type);
      const projectId = output?.project?.projectId;
      if (projectId && this.contextStore) {
        const metadata = {
          packetVersion: PACKET_VERSION,
          packetType: output.packetType,
          logicalRoleId: output.logicalRole?.logicalRoleId || null,
          promptContractVersion: output.provenance?.promptContractVersion || null,
          chars: output.budget?.chars || byteLength(output),
          truncated: Boolean(output.budget?.truncated),
          generatedAt: output.generatedAt
        };
        this.contextStore.recordPacketInMemory?.(projectId, metadata);
        Promise.resolve(this.contextStore.persist?.()).catch(() => {});
      }
      return output;
    }

    buildLeadPacket({ project, stage, runId, agentId = null }) {
      if (!project?.projectId) throw new Error("context_project_required");
      const normalizedStage = String(stage || project.stage || "").toUpperCase();
      const stageInputs = planningInputs(project, normalizedStage);
      const packet = this.basePacket({
        packetType: "lead",
        role: "lead",
        project,
        logicalRoleId: `lead:${project.projectId}:${normalizedStage}`,
        identity: { projectId: project.projectId, taskId: `planning:${normalizedStage.toLowerCase()}`, runId, agentId }
      });
      packet.stage = normalizedStage;
      packet.stageInputs = stageInputs.inputs;
      packet.artifactRefs = stageInputs.refs;
      packet.repositoryContext = repositoryContext(project);
      return this.finalize(packet, "lead");
    }

    buildTaskPacket({ project, task, runId, agentId = null, gitAssignment = null, reworkContext = null }) {
      if (!project?.projectId || !task?.id) throw new Error("context_task_required");
      const dependencyIds = Array.isArray(task.dependencies) ? task.dependencies : [];
      const dependencies = dependencyIds.map((id) => this.schedulerStore?.getTask?.(id)).filter(Boolean).map(compactTask);
      const packet = this.basePacket({
        packetType: "task",
        role: "worker",
        project,
        logicalRoleId: `task:${project.projectId}:${task.id}`,
        identity: { projectId: project.projectId, taskId: task.id, runId, agentId }
      });
      packet.task = compactValue(task);
      packet.dependencies = dependencies;
      packet.assignment = { git: compactValue(gitAssignment), rework: compactValue(reworkContext) };
      packet.repositoryContext = repositoryContext(project, task);
      packet.artifactRefs = dependencies.map((item) => item.artifactRef).filter(Boolean);
      return this.finalize(packet, "task");
    }

    buildReviewPacket({ project, task, review, packet, agentId = null }) {
      if (!project?.projectId || !task?.id || !review?.reviewId) throw new Error("context_review_required");
      const output = this.basePacket({
        packetType: "review",
        role: "reviewer",
        project,
        logicalRoleId: `review:${project.projectId}:${task.id}:${review.iteration || 1}`,
        identity: { projectId: project.projectId, taskId: task.id, runId: review.reviewId, agentId }
      });
      output.task = compactValue(task);
      output.review = compactValue({ reviewId: review.reviewId, iteration: review.iteration, authorAgentId: review.authorAgentId });
      output.evidence = compactValue(packet || {});
      output.repositoryContext = repositoryContext(project, task);
      output.artifactRefs = [compactValue(packet?.artifact || null)].filter(Boolean);
      return this.finalize(output, "review");
    }

    buildIntegrationPacket({ project, run, agentId = null, repairTask = null }) {
      if (!project?.projectId || !run?.runId) throw new Error("context_integration_required");
      const orderedTasks = (run.taskOrder || []).map((taskId) => this.schedulerStore?.getTask?.(taskId)).filter(Boolean).map(compactTask);
      const type = repairTask ? "repair" : "integration";
      const output = this.basePacket({
        packetType: type,
        role: "integrator",
        project,
        logicalRoleId: `integration:${project.projectId}`,
        identity: { projectId: project.projectId, taskId: "integration", runId: run.runId, agentId }
      });
      output.integration = compactValue({
        runId: run.runId,
        branch: run.branch,
        baseSha: run.baseSha,
        targetBranch: run.targetBranch,
        taskOrder: run.taskOrder,
        mergeTaskIds: run.mergeTaskIds,
        artifacts: run.artifacts,
        verificationCommands: run.verificationCommands
      });
      output.approvedTasks = orderedTasks;
      output.repositoryContext = repositoryContext(project);
      output.artifactRefs = capArray(run.artifacts, 40).map(compactValue);
      if (repairTask) output.repair = compactValue(repairTask);
      return this.finalize(output, type);
    }

    packetForRole({ role, taskId = null, reviewId = null, runId = null, agentId = null } = {}) {
      const project = this.projectStore?.getActiveProject?.();
      if (!project) return { ok: false, reason: "no_active_project" };
      const normalized = String(role || "").toLowerCase();
      try {
        if (normalized === "lead") {
          const stage = project.stage;
          const activeRunId = runId || project.currentRunId;
          if (!activeRunId || !stage || stage === "READY") return { ok: false, reason: "lead_role_not_active" };
          return { ok: true, packet: this.buildLeadPacket({ project, stage, runId: activeRunId, agentId }) };
        }
        if (normalized === "worker") {
          const task = this.schedulerStore?.getTask?.(taskId);
          if (!task) return { ok: false, reason: "unknown_task" };
          const activeRun = runId ? this.schedulerStore?.getRun?.(runId) : (task.activeRunId ? this.schedulerStore?.getRun?.(task.activeRunId) : null);
          const definition = task.definition || task;
          return { ok: true, packet: this.buildTaskPacket({ project, task: definition, runId: activeRun?.runId || runId || task.lastRunId || "unassigned", agentId, gitAssignment: activeRun?.git || null, reworkContext: task.reworkContext || null }) };
        }
        if (normalized === "reviewer") {
          const review = reviewId ? this.reviewStore?.get?.(reviewId) : this.reviewStore?.active?.()?.[0];
          if (!review) return { ok: false, reason: "unknown_review" };
          const task = this.schedulerStore?.getTask?.(review.taskId);
          if (!task) return { ok: false, reason: "unknown_task" };
          return { ok: true, packet: this.buildReviewPacket({ project, task: task.definition || task, review, packet: { artifact: task.lastArtifact || null, worker: review.packetSeed?.workerReport || null }, agentId }) };
        }
        if (normalized === "integrator") {
          const integrationRun = runId ? this.integrationStore?.getRun?.(runId) : this.integrationStore?.currentRun?.();
          if (!integrationRun) return { ok: false, reason: "integration_role_not_active" };
          const repairTask = integrationRun.activeRepairTaskId ? this.integrationStore?.getRepair?.(integrationRun.activeRepairTaskId) : null;
          return { ok: true, packet: this.buildIntegrationPacket({ project, run: { ...integrationRun, projectId: project.projectId }, repairTask, agentId }) };
        }
        return { ok: false, reason: "unknown_context_role", role: normalized };
      } catch (error) {
        return { ok: false, reason: error?.message || "context_packet_build_failed" };
      }
    }
  }

  let defaultService = null;
  function setDefaultService(service) { defaultService = service || null; return defaultService; }
  function getDefaultService() { return defaultService; }

  root.ContextPackets = {
    PACKET_VERSION,
    BUDGET_POLICY_VERSION,
    BUDGETS,
    ContextPacketService,
    setDefaultService,
    getDefaultService,
    enforceBudget,
    repositoryContext,
    compactTask,
    artifactRef,
    compactValue
  };

  if (typeof module !== "undefined" && module.exports) module.exports = root.ContextPackets;
})();
