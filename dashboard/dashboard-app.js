(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  }

  function formatTime(value) {
    const time = Number(value) || 0;
    if (!time) return "—";
    try { return new Date(time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }); }
    catch (_) { return String(time); }
  }

  function shortSha(value) {
    const text = String(value || "");
    return text ? text.slice(0, 10) : "—";
  }

  function jsonText(value, max = 1800) {
    if (value === null || value === undefined) return "—";
    let output;
    try { output = JSON.stringify(value, null, 2); } catch (_) { output = String(value); }
    return output.length > max ? `${output.slice(0, max)}…` : output;
  }

  function downloadText(filename, text) {
    if (!globalThis.document || !globalThis.URL || !globalThis.Blob) return false;
    const blob = new Blob([String(text || "")], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename || "chatgpt-orchestra.json";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  }

  function attributeSelector(name, value) {
    const raw = String(value ?? "");
    const escaped = globalThis.CSS?.escape ? globalThis.CSS.escape(raw) : raw.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return `[${name}="${escaped}"]`;
  }

  function statusBadge(status) {
    const normalized = String(status || "UNKNOWN");
    return `<span class="dashboard-badge status-${escapeHtml(normalized.toLowerCase())}">${escapeHtml(normalized)}</span>`;
  }

  function metricCard(label, value, hint = "") {
    return `<div class="dashboard-metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong>${hint ? `<small>${escapeHtml(hint)}</small>` : ""}</div>`;
  }

  class DashboardApp {
    constructor({ rootElement, transport, pollMs = 3000, download = downloadText, confirmAction = null, t = null } = {}) {
      if (!rootElement) throw new TypeError("dashboard_root_required");
      if (!transport?.query || !transport?.execute) throw new TypeError("dashboard_transport_invalid");
      this.rootElement = rootElement;
      this.transport = transport;
      this.pollMs = Math.max(1000, Number(pollMs) || 3000);
      this.download = download;
      this.t = typeof t === "function" ? t : (_key, fallback) => fallback;
      this.confirmAction = confirmAction || ((message) => typeof globalThis.confirm === "function" ? globalThis.confirm(message) : false);
      this.dashboard = null;
      this.localRepository = null;
      this.warningFilter = "info";
      this.timer = null;
      this.refreshing = false;
      this.lastError = null;
      this.onClick = (event) => this.handleClick(event);
      this.onChange = (event) => this.handleChange(event);
    }

    tr(key, fallback, params = {}) { return this.t(key, fallback, params); }

    start() {
      this.rootElement.addEventListener?.("click", this.onClick);
      this.rootElement.addEventListener?.("change", this.onChange);
      this.refresh();
      this.timer = setInterval(() => this.refresh(), this.pollMs);
      return this;
    }

    stop() {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      this.rootElement.removeEventListener?.("click", this.onClick);
      this.rootElement.removeEventListener?.("change", this.onChange);
    }

    async refresh() {
      if (this.refreshing) return;
      this.refreshing = true;
      try {
        const response = await this.transport.query("dashboard", { eventLimit: 60, decisionLimit: 60, minimumSeverity: "info" });
        if (!response?.ok) throw new Error(response?.reason || "dashboard_query_failed");
        this.dashboard = response.dashboard;
        const repositoryId = this.dashboard?.project?.repositoryRuntime?.repositoryId || null;
        this.localRepository = null;
        if (repositoryId) {
          const repository = await this.transport.query("repository", { repositoryId });
          if (repository?.ok) this.localRepository = repository.repository || null;
          else if (repository?.reason !== "repository_not_registered" && repository?.reason !== "unknown_api_query") throw new Error(repository?.reason || "repository_query_failed");
        }
        this.lastError = null;
      } catch (error) {
        this.lastError = error?.message || String(error);
      } finally {
        this.refreshing = false;
        this.render();
      }
    }

    filteredWarnings() {
      const ranks = { info: 0, warning: 1, error: 2, critical: 3 };
      const minimum = ranks[this.warningFilter] ?? 0;
      return (this.dashboard?.warnings || []).filter((item) => (ranks[item.severity] ?? 0) >= minimum);
    }

    render() {
      if (this.lastError && !this.dashboard) {
        this.rootElement.innerHTML = `<div class="dashboard-error">${escapeHtml(this.tr("dashboard.unavailable", "Dashboard unavailable: {error}", { error: this.lastError }))}</div>`;
        return;
      }
      const d = this.dashboard;
      if (!d) {
        this.rootElement.innerHTML = `<div class="dashboard-empty">${escapeHtml(this.tr("dashboard.loading", "Loading Dashboard…"))}</div>`;
        return;
      }
      const project = d.project;
      const recovery = d.recovery || {};
      const metrics = d.metrics || {};
      const taskMetrics = metrics.tasks || {};
      const agentMetrics = metrics.agents || {};
      const runsActive = Number(metrics.runs?.active) || 0;
      const reviewsActive = Number(metrics.reviews?.active) || 0;
      const warnings = this.filteredWarnings();
      const canPause = ["RUNNING", "IDLE"].includes(String(recovery.status || "IDLE"));
      const canResume = ["PAUSED", "STOPPED", "RECOVERY_REQUIRED"].includes(String(recovery.status || "IDLE"));
      const canStop = project && !["STOPPED", "STOPPING", "INTEGRATION_VERIFIED"].includes(String(recovery.status || "")) && project.status !== "INTEGRATION_VERIFIED";
      const canIntegrate = d.scheduler?.status === "READY_FOR_INTEGRATION" && d.integration?.summary?.status !== "INTEGRATION_VERIFIED";

      this.rootElement.innerHTML = `
        <div class="dashboard-shell">
          ${this.lastError ? `<div class="dashboard-error">${escapeHtml(this.lastError)}</div>` : ""}
          <div class="dashboard-topbar">
            <div>
              <h2>${escapeHtml(this.tr("dashboard.title", "Dashboard"))}</h2>
              <p>${project ? `${escapeHtml(project.status)} · ${escapeHtml(project.repository?.fullName || project.repository?.url || "repository")}` : escapeHtml(this.tr("dashboard.noProject", "No active project"))}</p>
            </div>
            <button class="secondary compact" data-dashboard-action="refresh">${escapeHtml(this.tr("dashboard.refresh", "Refresh"))}</button>
          </div>

          <div class="dashboard-metrics">
            ${metricCard(this.tr("dashboard.tasks", "Tasks"), `${taskMetrics.finished || 0}/${taskMetrics.total || 0}`, this.tr("dashboard.complete", "{percent}% complete", { percent: Math.round((taskMetrics.progress || 0) * 100) }))}
            ${metricCard(this.tr("dashboard.activeRoles", "Active roles"), `${runsActive + reviewsActive}`, this.tr("dashboard.workReview", "{work} work · {review} review", { work: runsActive, review: reviewsActive }))}
            ${metricCard(this.tr("dashboard.agents", "Agents"), `${agentMetrics.connected || 0}/${agentMetrics.total || 0}`, this.tr("dashboard.agentHint", "{busy} busy · {offline} offline", { busy: agentMetrics.busy || 0, offline: agentMetrics.offline || 0 }))}
            ${metricCard(this.tr("dashboard.recovery", "Recovery"), recovery.status || "IDLE", this.tr("dashboard.issueCount", "{count} issue(s)", { count: (recovery.issues || []).length }))}
          </div>

          <div class="dashboard-toolbar">
            <button data-dashboard-action="pause" ${canPause ? "" : "disabled"}>${escapeHtml(this.tr("dashboard.pause", "Pause"))}</button>
            <button data-dashboard-action="resume" ${canResume ? "" : "disabled"}>${escapeHtml(this.tr("dashboard.resume", "Resume"))}</button>
            <button class="secondary" data-dashboard-action="stopNow" ${canStop ? "" : "disabled"}>${escapeHtml(this.tr("dashboard.stopNow", "Stop Now"))}</button>
            <button class="secondary" data-dashboard-action="startIntegration" ${canIntegrate ? "" : "disabled"}>${escapeHtml(this.tr("dashboard.startIntegration", "Start Integration"))}</button>
            <button class="secondary" data-dashboard-action="exportProject" ${project ? "" : "disabled"}>${escapeHtml(this.tr("dashboard.exportProject", "Export Project"))}</button>
            <button class="secondary" data-dashboard-action="exportDebug">${escapeHtml(this.tr("dashboard.exportDebug", "Export Debug"))}</button>
          </div>

          ${this.renderProject(project, d)}
          ${this.renderWarnings(warnings)}
          ${this.renderTasks(d.tasks || [], d.agents || [])}
          ${this.renderAgents(d.agents || [])}
          ${this.renderReviews(d.reviews || {})}
          ${this.renderIntegration(d.integration || {})}
          ${this.renderTimeline(d.events || [], d.rejections || [])}
          ${this.renderDecisions(d.decisions || [])}
        </div>`;
    }

    renderProject(project, d) {
      if (!project) return `<section class="dashboard-section"><h3>${escapeHtml(this.tr("dashboard.project", "Project"))}</h3><p class="dashboard-muted">${escapeHtml(this.tr("dashboard.noProject", "No active project"))}.</p></section>`;
      const git = d.scheduler?.git || {};
      const repositoryId = project.repositoryRuntime?.repositoryId || null;
      const trust = this.localRepository?.trust || null;
      const localControls = repositoryId ? `
        <div class="dashboard-task-controls">
          ${trust === "TRUSTED"
            ? `<button class="secondary" data-dashboard-action="disableLocalExecution" data-repository-id="${escapeHtml(repositoryId)}">${escapeHtml(this.tr("dashboard.disableLocal", "Disable Local Execution"))}</button>`
            : `<button data-dashboard-action="enableLocalExecution" data-repository-id="${escapeHtml(repositoryId)}">${escapeHtml(this.tr("dashboard.enableLocal", "Enable Local Execution"))}</button>`}
          <small>${escapeHtml(trust === "TRUSTED" ? this.tr("dashboard.localTrusted", "Repository-defined argv commands may run inside Orchestra worktrees.") : this.tr("dashboard.localBlocked", "Repository-defined commands are blocked until you explicitly trust this repository."))}</small>
        </div>` : "";
      return `<section class="dashboard-section">
        <div class="dashboard-section-head"><h3>${escapeHtml(this.tr("dashboard.project", "Project"))}</h3>${statusBadge(project.status)}</div>
        <p class="dashboard-goal">${escapeHtml(project.goal || "")}</p>
        <div class="dashboard-kv">
          <span>${escapeHtml(this.tr("dashboard.repository", "Repository"))}</span><strong>${escapeHtml(project.repository?.url || "—")}</strong>
          <span>${escapeHtml(this.tr("dashboard.base", "Base"))}</span><strong>${escapeHtml(git.defaultBranch || "—")}@${escapeHtml(shortSha(git.baseSha))}</strong>
          <span>${escapeHtml(this.tr("dashboard.stage", "Stage"))}</span><strong>${escapeHtml(project.stage || "—")}</strong>
          <span>${escapeHtml(this.tr("dashboard.persistence", "Persistence"))}</span><strong>${escapeHtml(d.persistence?.backend || "unknown")} · schema ${escapeHtml(d.persistence?.portableSchemaVersion || "?")}</strong>
          ${repositoryId ? `<span>${escapeHtml(this.tr("dashboard.localExecution", "Local execution"))}</span><strong>${escapeHtml(trust || "UNAVAILABLE")}</strong>` : ""}
        </div>
        ${localControls}
      </section>`;
    }

    renderWarnings(warnings) {
      return `<section class="dashboard-section">
        <div class="dashboard-section-head">
          <h3>${escapeHtml(this.tr("dashboard.warnings", "Warnings / NEEDS_USER"))}</h3>
          <select data-dashboard-filter="warnings" class="dashboard-filter">
            ${["info", "warning", "error", "critical"].map((value) => `<option value="${value}" ${this.warningFilter === value ? "selected" : ""}>${value}+</option>`).join("")}
          </select>
        </div>
        <div class="dashboard-list">${warnings.length ? warnings.map((item) => `<div class="dashboard-warning severity-${escapeHtml(item.severity)}"><strong>${escapeHtml(item.code)}</strong><span>${escapeHtml(item.message)}</span><small>${formatTime(item.at)}</small></div>`).join("") : `<p class="dashboard-muted">${escapeHtml(this.tr("dashboard.noWarnings", "No warnings at this filter."))}</p>`}</div>
      </section>`;
    }

    renderTasks(tasks, agents) {
      const idleWorkers = agents.filter((agent) => agent.role === "worker" && agent.connected && agent.status === "IDLE");
      return `<section class="dashboard-section">
        <div class="dashboard-section-head"><h3>${escapeHtml(this.tr("dashboard.tasksDag", "Tasks / DAG"))}</h3><span>${tasks.length}</span></div>
        <div class="dashboard-task-list">${tasks.length ? tasks.map((task) => {
          const controls = task.controls || {};
          const dependencyText = task.dependencies?.length ? task.dependencies.join(", ") : this.tr("dashboard.none", "none");
          const artifact = task.lastArtifact;
          return `<details class="dashboard-task" ${["RUNNING", "NEEDS_USER", "REVIEWING"].includes(task.status) ? "open" : ""}>
            <summary><span><strong>${escapeHtml(task.taskId)}</strong> · ${escapeHtml(task.title)}</span>${statusBadge(task.status)}</summary>
            <div class="dashboard-task-body">
              <p>${escapeHtml(task.objective || "")}</p>
              <div class="dashboard-kv compact">
                <span>${escapeHtml(this.tr("dashboard.dependencies", "Dependencies"))}</span><strong>${escapeHtml(dependencyText)}</strong>
                <span>${escapeHtml(this.tr("dashboard.priority", "Priority"))}</span><strong>${escapeHtml(task.priority)}</strong>
                <span>${escapeHtml(this.tr("dashboard.riskSize", "Risk / size"))}</span><strong>${escapeHtml(task.risk)} / ${escapeHtml(task.estimatedComplexity)}</strong>
                <span>${escapeHtml(this.tr("dashboard.run", "Run"))}</span><strong>${escapeHtml(task.activeRunId || task.lastRunId || "—")}</strong>
                <span>${escapeHtml(this.tr("dashboard.artifact", "Artifact"))}</span><strong>${artifact ? `${escapeHtml(artifact.branch || "branch")}@${escapeHtml(shortSha(artifact.commit))}` : "—"}</strong>
              </div>
              ${task.acceptanceCriteria?.length ? `<div class="dashboard-evidence"><strong>${escapeHtml(this.tr("dashboard.acceptance", "Acceptance"))}</strong><ul>${task.acceptanceCriteria.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></div>` : ""}
              ${task.lastReview ? `<div class="dashboard-evidence"><strong>${escapeHtml(this.tr("dashboard.lastReview", "Last review"))}</strong><pre>${escapeHtml(jsonText(task.lastReview))}</pre></div>` : ""}
              ${task.lastError ? `<div class="dashboard-evidence"><strong>${escapeHtml(this.tr("dashboard.lastError", "Last error"))}</strong><pre>${escapeHtml(jsonText(task.lastError))}</pre></div>` : ""}
              <div class="dashboard-task-controls">
                <button data-dashboard-action="retryTask" data-task-id="${escapeHtml(task.taskId)}" ${controls.canRetry ? "" : "disabled"}>${escapeHtml(this.tr("dashboard.retry", "Retry"))}</button>
                <button class="secondary" data-dashboard-action="cancelTask" data-task-id="${escapeHtml(task.taskId)}" ${controls.canCancel ? "" : "disabled"}>${escapeHtml(this.tr("dashboard.cancel", "Cancel"))}</button>
                <button class="secondary" data-dashboard-action="requestReview" data-task-id="${escapeHtml(task.taskId)}" ${controls.canRequestReview ? "" : "disabled"}>${escapeHtml(this.tr("dashboard.review", "Review"))}</button>
                <label class="dashboard-inline-control">${escapeHtml(this.tr("dashboard.priority", "Priority"))} <input type="number" min="-100" max="100" value="${escapeHtml(task.priority)}" data-priority-task="${escapeHtml(task.taskId)}" ${controls.canChangePriority ? "" : "disabled"}></label>
                <button class="secondary" data-dashboard-action="changePriority" data-task-id="${escapeHtml(task.taskId)}" ${controls.canChangePriority ? "" : "disabled"}>${escapeHtml(this.tr("dashboard.set", "Set"))}</button>
                <select data-reassign-task="${escapeHtml(task.taskId)}" ${controls.canReassign && idleWorkers.length ? "" : "disabled"}><option value="">${escapeHtml(this.tr("dashboard.worker", "Worker…"))}</option>${idleWorkers.map((agent) => `<option value="${escapeHtml(agent.agentId)}">${escapeHtml(agent.label || agent.agentId)}</option>`).join("")}</select>
                <button class="secondary" data-dashboard-action="reassignAgent" data-task-id="${escapeHtml(task.taskId)}" ${controls.canReassign && idleWorkers.length ? "" : "disabled"}>${escapeHtml(this.tr("dashboard.assign", "Assign"))}</button>
              </div>
            </div>
          </details>`;
        }).join("") : `<p class="dashboard-muted">${escapeHtml(this.tr("dashboard.noTaskGraph", "Task graph not available yet."))}</p>`}</div>
      </section>`;
    }

    renderAgents(agents) {
      return `<section class="dashboard-section">
        <div class="dashboard-section-head"><h3>${escapeHtml(this.tr("dashboard.agentHealth", "Agent health"))}</h3><span>${agents.length}</span></div>
        <div class="dashboard-agent-grid">${agents.length ? agents.map((agent) => `<div class="dashboard-agent"><div><strong>${escapeHtml(agent.label || agent.agentId)}</strong><small>${escapeHtml(agent.role)} · ${escapeHtml(this.tr("dashboard.seen", "seen {time}", { time: formatTime(agent.lastSeenAt) }))}</small></div>${statusBadge(agent.connected ? agent.status : "OFFLINE")}<button class="secondary compact" data-dashboard-action="openExecutor" data-agent-id="${escapeHtml(agent.agentId)}" ${agent.connected ? "" : "disabled"}>${escapeHtml(this.tr("dashboard.open", "Open"))}</button></div>`).join("") : `<p class="dashboard-muted">${escapeHtml(this.tr("dashboard.noAgents", "No agents registered."))}</p>`}</div>
      </section>`;
    }

    renderReviews(reviews) {
      const items = reviews.items || [];
      return `<section class="dashboard-section"><div class="dashboard-section-head"><h3>${escapeHtml(this.tr("dashboard.reviewEvidence", "Review evidence"))}</h3><span>${items.length}</span></div><div class="dashboard-list">${items.length ? [...items].reverse().slice(0, 20).map((review) => `<details class="dashboard-evidence"><summary>${statusBadge(review.status)} ${escapeHtml(review.taskId)} · ${escapeHtml(review.reviewId)}</summary><pre>${escapeHtml(jsonText(review.result || { reviewerAgentId: review.reviewerAgentId, lastError: review.lastError }))}</pre></details>`).join("") : `<p class="dashboard-muted">${escapeHtml(this.tr("dashboard.noReviews", "No reviews yet."))}</p>`}</div></section>`;
    }

    renderIntegration(integration) {
      const summary = integration.summary || {};
      const current = summary.currentRun || null;
      const final = summary.summary || null;
      return `<section class="dashboard-section"><div class="dashboard-section-head"><h3>${escapeHtml(this.tr("dashboard.integrationEvidence", "Integration evidence"))}</h3>${statusBadge(summary.status || "IDLE")}</div>
        ${current ? `<div class="dashboard-kv compact"><span>Run</span><strong>${escapeHtml(current.runId)}</strong><span>${escapeHtml(this.tr("dashboard.agent", "Agent"))}</span><strong>${escapeHtml(current.agentId || "—")}</strong><span>${escapeHtml(this.tr("dashboard.branch", "Branch"))}</span><strong>${escapeHtml(current.branch || "—")}</strong><span>Base</span><strong>${escapeHtml(shortSha(current.baseSha))}</strong></div>` : `<p class="dashboard-muted">${escapeHtml(this.tr("dashboard.noIntegration", "No active integration run."))}</p>`}
        ${final ? `<details class="dashboard-evidence" open><summary>${escapeHtml(this.tr("dashboard.verifiedSummary", "Verified summary"))}</summary><pre>${escapeHtml(jsonText(final, 4000))}</pre></details>` : ""}
        ${(integration.repairs || []).length ? `<details class="dashboard-evidence"><summary>${escapeHtml(this.tr("dashboard.repairs", "Repairs ({count})", { count: integration.repairs.length }))}</summary><pre>${escapeHtml(jsonText(integration.repairs, 4000))}</pre></details>` : ""}
      </section>`;
    }

    renderTimeline(events, rejections) {
      const rows = [
        ...events.map((record) => ({ at: record.receivedAt || record.acceptedAt, kind: "event", label: `${record.event?.event || "EVENT"} · ${record.event?.taskId || ""}`, detail: record.event?.payload || null })),
        ...rejections.map((record) => ({ at: record.receivedAt || record.at, kind: "rejection", label: `${this.tr("dashboard.rejected", "REJECTED")} · ${record.reason || "unknown"}`, detail: record.event || record.details || null }))
      ].sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, 60);
      return `<section class="dashboard-section"><div class="dashboard-section-head"><h3>${escapeHtml(this.tr("dashboard.timeline", "Event timeline"))}</h3><span>${rows.length}</span></div><div class="dashboard-timeline">${rows.length ? rows.map((row) => `<div class="dashboard-event ${row.kind}"><time>${formatTime(row.at)}</time><strong>${escapeHtml(row.label)}</strong><span>${escapeHtml(jsonText(row.detail, 600))}</span></div>`).join("") : `<p class="dashboard-muted">${escapeHtml(this.tr("dashboard.noEvents", "No events yet."))}</p>`}</div></section>`;
    }

    renderDecisions(decisions) {
      const rows = [...decisions].reverse().slice(0, 60);
      return `<section class="dashboard-section"><div class="dashboard-section-head"><h3>${escapeHtml(this.tr("dashboard.scheduler", "Scheduler explanation"))}</h3><span>${rows.length}</span></div><div class="dashboard-timeline">${rows.length ? rows.map((item) => `<div class="dashboard-event"><time>${formatTime(item.at)}</time><strong>${escapeHtml(item.type)}</strong><span>${escapeHtml(jsonText(item.details, 900))}</span></div>`).join("") : `<p class="dashboard-muted">${escapeHtml(this.tr("dashboard.noDecisions", "No scheduler decisions yet."))}</p>`}</div></section>`;
    }

    async command(name, payload = {}) {
      const response = await this.transport.execute(name, payload);
      if (!response?.ok) {
        this.lastError = `${name}: ${response?.reason || "unknown_error"}`;
        this.render();
        return response;
      }
      this.lastError = null;
      await this.refresh();
      return response;
    }

    async exportBundle(command) {
      const response = await this.transport.execute(command, {});
      if (!response?.ok) {
        this.lastError = `${command}: ${response?.reason || "unknown_error"}`;
        this.render();
        return;
      }
      this.download(response.filename, response.serialized);
    }

    async handleClick(event) {
      const button = event.target?.closest?.("[data-dashboard-action]");
      if (!button || button.disabled) return;
      const action = button.dataset.dashboardAction;
      const taskId = button.dataset.taskId;
      const repositoryId = button.dataset.repositoryId;
      if (action === "refresh") return this.refresh();
      if (["pause", "resume", "stopNow", "startIntegration"].includes(action)) return this.command(action);
      if (action === "exportProject") return this.exportBundle("exportProjectBundle");
      if (action === "exportDebug") return this.exportBundle("exportDebugBundle");
      if (action === "enableLocalExecution") {
        if (!repositoryId) return;
        const confirmed = this.confirmAction(this.tr("dashboard.trustConfirm", "Trust this repository to run its structured local verification commands inside isolated Orchestra worktrees? Only enable this for repositories you trust."));
        if (!confirmed) return;
        return this.command("setRepositoryTrust", { repositoryId, trust: "TRUSTED" });
      }
      if (action === "disableLocalExecution") {
        if (!repositoryId) return;
        return this.command("setRepositoryTrust", { repositoryId, trust: "UNTRUSTED" });
      }
      if (action === "openExecutor") return this.command("openExecutor", { agentId: button.dataset.agentId });
      if (action === "retryTask") return this.command("retryTask", { taskId });
      if (action === "requestReview") return this.command("requestReview", { taskId });
      if (action === "cancelTask") {
        const first = await this.transport.execute("cancelTask", { taskId, cascade: false });
        if (first?.ok) return this.refresh();
        if (first?.reason === "task_has_downstream_dependents" && this.confirmAction(this.tr("dashboard.cancelDownstream", "Cancel {taskId} and downstream tasks: {tasks}?", { taskId, tasks: (first.dependentTaskIds || []).join(", ") }))) return this.command("cancelTask", { taskId, cascade: true });
        this.lastError = `cancelTask: ${first?.reason || "unknown_error"}`;
        return this.render();
      }
      if (action === "changePriority") {
        const input = this.rootElement.querySelector?.(attributeSelector("data-priority-task", taskId));
        return this.command("changePriority", { taskId, priority: Number(input?.value) || 0 });
      }
      if (action === "reassignAgent") {
        const select = this.rootElement.querySelector?.(attributeSelector("data-reassign-task", taskId));
        if (!select?.value) return;
        return this.command("reassignAgent", { taskId, agentId: select.value });
      }
    }

    handleChange(event) {
      if (event.target?.dataset?.dashboardFilter === "warnings") {
        this.warningFilter = event.target.value || "info";
        this.render();
      }
    }
  }

  root.DashboardApp = DashboardApp;
  root.DashboardUtils = { escapeHtml, formatTime, shortSha, jsonText, downloadText, attributeSelector };
  if (typeof module !== "undefined" && module.exports) module.exports = { DashboardApp, escapeHtml, formatTime, shortSha, jsonText, downloadText, attributeSelector };
})();