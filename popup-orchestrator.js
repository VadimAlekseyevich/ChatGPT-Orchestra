(() => {
  "use strict";
  const TYPES = globalThis.ChatGPTOrchestra?.MESSAGE_TYPES;
  if (!TYPES) return;

  const ui = {
    runtimeStatus: document.querySelector("#runtimeStatus"),
    projectStatus: document.querySelector("#projectStatus"),
    executionStatus: document.querySelector("#executionStatus"),
    repositoryUrl: document.querySelector("#repositoryUrl"),
    projectGoal: document.querySelector("#projectGoal"),
    startProject: document.querySelector("#startProject"),
    startExecution: document.querySelector("#startExecution"),
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
    ui.projectStatus.textContent = `${project.status} · ${project.stage}${tasks ? ` · ${tasks} tasks` : ""}`;
    if (!ui.repositoryUrl.value) ui.repositoryUrl.value = project.repository?.url || "";
    if (!ui.projectGoal.value) ui.projectGoal.value = project.goal || "";
  }

  function renderScheduler(project, scheduler) {
    if (!scheduler || !project || scheduler.projectId !== project.projectId || scheduler.taskCount === 0) {
      ui.executionStatus.textContent = "Execution: not started";
      ui.startExecution.disabled = project?.status !== "READY";
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
    ui.executionStatus.textContent = `${scheduler.status} · ${approved}/${scheduler.taskCount} approved · ${scheduler.activeRuns} work active${reviewText}${needsUser ? ` · ${needsUser} needs user` : ""}${gitText}`;
    ui.startExecution.disabled = true;
  }

  function renderState(state) {
    if (!state) return;
    ui.runtimeStatus.textContent = `Runtime: ${state.runtimeStatus || "idle"}`;
    renderProject(state.project);
    renderScheduler(state.project, state.scheduler);
    ui.leadStatus.textContent = statusText(state.lead);
    const connected = (state.workers || []).filter((worker) => !["OFFLINE", "ERROR"].includes(worker.status)).length;
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
    const response = await send(TYPES.ORCHESTRATOR_GET_STATE);
    if (response.ok) renderState(response.state);
    else ui.runtimeStatus.textContent = `Runtime error: ${response.reason || "unknown"}`;
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

  ui.refreshPool?.addEventListener("click", refresh);
  ui.registerLead?.addEventListener("click", registerLead);
  ui.createWorkers?.addEventListener("click", createWorkers);
  ui.startProject?.addEventListener("click", startProject);
  ui.startExecution?.addEventListener("click", startExecution);

  refresh();
  setInterval(refresh, 3000);
})();