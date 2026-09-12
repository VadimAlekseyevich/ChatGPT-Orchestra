(() => {
  "use strict";

  const TYPES = globalThis.ChatGPTOrchestra?.MESSAGE_TYPES;
  if (!TYPES) return;

  const ui = {
    runtimeStatus: document.querySelector("#runtimeStatus"),
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
        if (chrome.runtime.lastError) {
          resolve({ ok: false, reason: "runtime_error", message: chrome.runtime.lastError.message });
          return;
        }
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

  function renderState(state) {
    if (!state) return;
    ui.runtimeStatus.textContent = `Runtime: ${state.runtimeStatus || "idle"}`;
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
    if (!response.ok) {
      ui.runtimeStatus.textContent = `Lead: ${response.reason || "ошибка"}`;
      return;
    }
    renderState(response.state);
  }

  async function createWorkers() {
    ui.createWorkers.disabled = true;
    const count = Math.max(1, Math.min(4, Number(ui.workerCount.value) || 3));
    ui.workerCount.value = count;
    const response = await send(TYPES.ORCHESTRATOR_CREATE_WORKERS, { count });
    ui.createWorkers.disabled = false;
    if (!response.ok) {
      ui.runtimeStatus.textContent = `Workers: ${response.reason || "ошибка"}`;
      return;
    }
    renderState(response.state);
  }

  ui.refreshPool?.addEventListener("click", refresh);
  ui.registerLead?.addEventListener("click", registerLead);
  ui.createWorkers?.addEventListener("click", createWorkers);

  refresh();
  setInterval(refresh, 3000);
})();
