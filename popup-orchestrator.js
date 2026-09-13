(() => {
  "use strict";
  const TYPES = globalThis.ChatGPTOrchestra?.MESSAGE_TYPES;
  if (!TYPES) return;

  const ui = {
    runtimeStatus: document.querySelector("#runtimeStatus"),
    projectStatus: document.querySelector("#projectStatus"),
    executionStatus: document.querySelector("#executionStatus"),
    recoveryStatus: document.querySelector("#recoveryStatus"),
    persistenceStatus: document.querySelector("#persistenceStatus"),
    repositoryUrl: document.querySelector("#repositoryUrl"),
    projectGoal: document.querySelector("#projectGoal"),
    startProject: document.querySelector("#startProject"),
    startExecution: document.querySelector("#startExecution"),
    pauseProject: document.querySelector("#pauseProject"),
    resumeProject: document.querySelector("#resumeProject"),
    stopNow: document.querySelector("#stopNow"),
    exportProject: document.querySelector("#exportProject"),
    importProject: document.querySelector("#importProject"),
    importProjectFile: document.querySelector("#importProjectFile"),
    leadStatus: document.querySelector("#leadStatus"),
    workersStatus: document.querySelector("#workersStatus"),
    agentsList: document.querySelector("#agentsList"),
    workerCount: document.querySelector("#workerCount"),
    registerLead: document.querySelector("#registerLead"),
    createWorkers: document.querySelector("#createWorkers"),
    refreshPool: document.querySelector("#refreshPool")
  };

  function send(type, payload = {}) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type, payload }, (response) => {
        if (chrome.runtime.lastError) return resolve({ ok: false, reason: "runtime_error", message: chrome.runtime.lastError.message });
        resolve(response || { ok: false, reason: "empty_response" });
      });
    });
  }

  function statusText(agent) {
    if (!agent) return "не привязан";
    return `${agent.status || "UNKNOWN"}${agent.label ? ` · ${agent.label}` : ""}`;
  }

  function renderAgent(agent) {
    const row = document.createElement("div");
    row.className = "agent-row";
    const meta = document.createElement("div");
    const title = document.createElement("strong");
    const details = document.createElement("span");
    title.textContent = agent.label || agent.role || agent.agentId;
    details.textContent = `${agent.status} · ${agent.agentId.slice(0, 14)}…`;
    meta.append(title, details);
    const badge = document.createElement("span");
    badge.className = `agent-status status-${String(agent.status || "unknown").toLowerCase()}`;
    badge.textContent = agent.status || "UNKNOWN";
    row.append(meta, badge);
    return row;
  }

  function renderProject(project) {
    if (!project) {
      ui.projectStatus.textContent = "Project: none";
      return;
    }
    const tasks = Number(project.taskCount) || 0;
    const workStatus = project.workStatus ? ` · work ${project.workStatus}` : "";
    ui.projectStatus.textContent = `${project.status}${workStatus} · ${project.stage}${tasks ? ` · ${tasks} tasks` : ""}`;
    if (!ui.repositoryUrl.value) ui.repositoryUrl.value = project.repository?.url || "";
    if (!ui.projectGoal.value) ui.projectGoal.value = project.goal || "";
  }

  function renderScheduler(project, scheduler, recovery) {
    const lifecycleBlocked = recovery && !["IDLE", "RUNNING"].includes(recovery.status);
    if (!scheduler || !project || scheduler.projectId !== project.projectId || scheduler.taskCount === 0) {
      ui.executionStatus.textContent = "Execution: not started";
      ui.startExecution.disabled = lifecycleBlocked || project?.status !== "READY";
      return;
    }
    const counts = scheduler.counts || {};
    const approved = Number(counts.APPROVED) || 0;
    const needsUser = Number(counts.NEEDS_USER) || 0;
    const review = scheduler.review || {};
    const reviewWaiting = (Number(review.pending) || 0) + (Number(review.active) || 0);
    const git = scheduler.git;
    const gitText = git?.defaultBranch && git?.baseSha ? ` · git ${git.defaultBranch}@${String(git.baseSha).slice(0, 8)}` : "";
    const reviewText = reviewWaiting ? ` · review ${review.active || 0} active/${review.pending || 0} pending` : "";
    const integration = project.execution?.details?.integration || null;
    let integrationText = "";
    if (integration?.branch) {
      const commit = integration.commit ? `@${String(integration.commit).slice(0, 8)}` : "";
      integrationText = ` · integration ${integration.branch}${commit}`;
    } else if (["READY_FOR_INTEGRATION", "INTEGRATING", "INTEGRATION_REPAIRING"].includes(project.workStatus || project.status)) {
      integrationText = ` · integration ${(project.workStatus || project.status).toLowerCase()}`;
    }
    ui.executionStatus.textContent = `${scheduler.status} · ${approved}/${scheduler.taskCount} approved · ${scheduler.activeRuns} work active${reviewText}${needsUser ? ` · ${needsUser} needs user` : ""}${gitText}${integrationText}`;
    ui.startExecution.disabled = true;
  }

  function renderRecovery(project, recovery) {
    const status = recovery?.status || "IDLE";
    const safe = recovery?.safePoint || {};
    const activeCount = (safe.activeWorkerRuns?.length || 0) + (safe.activeReviews?.length || 0) + (safe.activeIntegration ? 1 : 0) + (safe.planningActive ? 1 : 0);
    const issueCount = recovery?.issues?.length || 0;
    ui.recoveryStatus.textContent = `Recovery: ${status}${status === "PAUSING" ? ` · ${activeCount} active` : ""}${issueCount ? ` · ${issueCount} issue(s)` : ""}`;

    const hasProject = Boolean(project);
    ui.pauseProject.disabled = !hasProject || !["RUNNING", "IDLE"].includes(status);
    ui.resumeProject.disabled = !hasProject || !["PAUSED", "STOPPED", "RECOVERY_REQUIRED"].includes(status);
    ui.stopNow.disabled = !hasProject || ["STOPPED", "STOPPING", "INTEGRATION_VERIFIED"].includes(status) || project?.workStatus === "INTEGRATION_VERIFIED" || project?.status === "INTEGRATION_VERIFIED";
    ui.startProject.disabled = ["PAUSING", "PAUSED", "STOPPING", "STOPPED", "RECOVERING", "RECOVERY_REQUIRED"].includes(status);
    ui.exportProject.disabled = !hasProject;
  }

  function renderState(state) {
    if (!state) return;
    ui.runtimeStatus.textContent = `Runtime: ${state.runtimeStatus || "idle"}`;
    renderProject(state.project);
    renderScheduler(state.project, state.scheduler, state.recovery);
    renderRecovery(state.project, state.recovery);
    ui.leadStatus.textContent = statusText(state.lead);
    const connected = (state.workers || []).filter((worker) => worker.status !== "OFFLINE").length;
    ui.workersStatus.textContent = `${connected}/${(state.workers || []).length}`;
    ui.agentsList.replaceChildren();
    const agents = [state.lead, ...(state.workers || [])].filter(Boolean);
    if (!agents.length) {
      const empty = document.createElement("p");
      empty.className = "empty-state compact-empty";
      empty.textContent = "Агенты ещё не зарегистрированы.";
      ui.agentsList.appendChild(empty);
      return;
    }
    for (const agent of agents) ui.agentsList.appendChild(renderAgent(agent));
  }

  async function refresh() {
    const [response, persistence] = await Promise.all([
      send(TYPES.ORCHESTRATOR_GET_STATE),
      send(TYPES.ORCHESTRATOR_GET_PERSISTENCE)
    ]);
    if (response.ok) renderState(response.state);
    else ui.runtimeStatus.textContent = `Runtime error: ${response.reason || "unknown"}`;
    if (persistence.ok && ui.persistenceStatus) {
      const info = persistence.persistence || {};
      ui.persistenceStatus.textContent = `Persistence: schema ${info.portableSchemaVersion || "?"} · ${info.backend || "unknown"}`;
    }
  }

  async function registerLead() {
    ui.registerLead.disabled = true;
    const response = await send(TYPES.ORCHESTRATOR_REGISTER_ACTIVE_LEAD);
    ui.registerLead.disabled = false;
    if (!response.ok) return void (ui.runtimeStatus.textContent = `Lead: ${response.reason || "ошибка"}`);
    renderState(response.state);
  }

  async function createWorkers() {
    ui.createWorkers.disabled = true;
    const count = Math.max(1, Math.min(4, Number(ui.workerCount.value) || 3));
    ui.workerCount.value = count;
    const response = await send(TYPES.ORCHESTRATOR_CREATE_WORKERS, { count });
    ui.createWorkers.disabled = false;
    if (!response.ok) return void (ui.runtimeStatus.textContent = `Workers: ${response.reason || "ошибка"}`);
    renderState(response.state);
  }

  async function startProject() {
    ui.startProject.disabled = true;
    const response = await send(TYPES.ORCHESTRATOR_START_PROJECT, {
      repositoryUrl: ui.repositoryUrl.value.trim(),
      goal: ui.projectGoal.value.trim()
    });
    ui.startProject.disabled = false;
    if (!response.ok) {
      ui.projectStatus.textContent = `Project error: ${response.reason || "unknown"}`;
      return;
    }
    await refresh();
  }

  async function startExecution() {
    ui.startExecution.disabled = true;
    const maxWorkers = Math.max(1, Math.min(4, Number(ui.workerCount.value) || 3));
    ui.workerCount.value = maxWorkers;
    const response = await send(TYPES.ORCHESTRATOR_START_EXECUTION, { maxWorkers, maxReviewIterations: 3 });
    if (!response.ok) {
      ui.executionStatus.textContent = `Execution error: ${response.reason || "unknown"}`;
      ui.startExecution.disabled = false;
      return;
    }
    renderState(response.state);
  }

  async function lifecycleCommand(type, label) {
    for (const button of [ui.pauseProject, ui.resumeProject, ui.stopNow]) if (button) button.disabled = true;
    const response = await send(type);
    if (!response.ok) ui.recoveryStatus.textContent = `${label}: ${response.reason || "unknown"}`;
    await refresh();
  }

  function downloadText(filename, text) {
    const blob = new Blob([text], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename || "chatgpt-orchestra-project.bundle.json";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function exportProject() {
    ui.exportProject.disabled = true;
    ui.persistenceStatus.textContent = "Persistence: exporting…";
    const response = await send(TYPES.ORCHESTRATOR_EXPORT_PROJECT);
    ui.exportProject.disabled = false;
    if (!response.ok) {
      ui.persistenceStatus.textContent = `Export error: ${response.reason || "unknown"}`;
      return;
    }
    downloadText(response.filename, response.serialized);
    ui.persistenceStatus.textContent = `Exported: ${response.filename} · ${response.bytes || 0} bytes`;
  }

  async function importProjectFile(file) {
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) {
      ui.persistenceStatus.textContent = "Import error: bundle is larger than 8 MiB";
      return;
    }
    ui.importProject.disabled = true;
    ui.persistenceStatus.textContent = "Persistence: validating/importing…";
    let text;
    try { text = await file.text(); }
    catch (_) {
      ui.importProject.disabled = false;
      ui.persistenceStatus.textContent = "Import error: unable to read file";
      return;
    }
    const response = await send(TYPES.ORCHESTRATOR_IMPORT_PROJECT, { bundle: text, replace: false });
    ui.importProject.disabled = false;
    if (!response.ok) {
      ui.persistenceStatus.textContent = `Import error: ${response.reason || "unknown"}`;
      return;
    }
    ui.persistenceStatus.textContent = `Imported ${response.projectId}. Reloading for reconciliation…`;
    if (response.reloadRequired) setTimeout(() => chrome.runtime.reload(), 300);
  }

  ui.refreshPool?.addEventListener("click", refresh);
  ui.registerLead?.addEventListener("click", registerLead);
  ui.createWorkers?.addEventListener("click", createWorkers);
  ui.startProject?.addEventListener("click", startProject);
  ui.startExecution?.addEventListener("click", startExecution);
  ui.pauseProject?.addEventListener("click", () => lifecycleCommand(TYPES.ORCHESTRATOR_PAUSE, "Pause"));
  ui.resumeProject?.addEventListener("click", () => lifecycleCommand(TYPES.ORCHESTRATOR_RESUME, "Resume"));
  ui.stopNow?.addEventListener("click", () => lifecycleCommand(TYPES.ORCHESTRATOR_STOP_NOW, "Stop Now"));
  ui.exportProject?.addEventListener("click", exportProject);
  ui.importProject?.addEventListener("click", () => ui.importProjectFile?.click());
  ui.importProjectFile?.addEventListener("change", async () => {
    const file = ui.importProjectFile.files?.[0] || null;
    ui.importProjectFile.value = "";
    await importProjectFile(file);
  });

  refresh();
  setInterval(refresh, 3000);
})();
