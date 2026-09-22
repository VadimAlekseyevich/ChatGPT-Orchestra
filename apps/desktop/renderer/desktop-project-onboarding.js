(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};
  const MODE_LOCAL = "local";
  const MODE_CLONE = "clone";
  const PROJECT_MODES = new Set([MODE_LOCAL, MODE_CLONE]);
  const TERMINAL_PROJECT_STATUSES = new Set(["INTEGRATION_VERIFIED", "FAILED", "CANCELLED"]);
  const SAFE_PROJECT_CHANGE_STATES = new Set(["IDLE", "PAUSED", "STOPPED", "RECOVERY_REQUIRED"]);
  const RETRYABLE_PLANNING_ARTIFACT_FAILURES = new Set([
    "stage_artifact_not_object",
    "repository_access_status_missing",
    "repository_inspection_evidence_missing",
    "repository_commands_missing",
    "plan_milestones_missing",
    "completion_definition_missing",
    "critique_findings_missing",
    "revised_plan_milestones_missing",
    "agents_md_proposal_invalid",
    "task_graph_tasks_missing"
  ]);

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  }

  function normalizeGitHubUrl(value) {
    const raw = String(value || "").trim();
    const match = raw.match(/^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/?$/i);
    if (!match) return null;
    const owner = match[1];
    const repository = String(match[2] || "").replace(/\.git$/i, "");
    if (!owner || !repository) return null;
    return `https://github.com/${owner}/${repository}`;
  }

  function createRepositoryId() {
    const random = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return `repo-${String(random).replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 100)}`;
  }

  function repositoryPreparationKey(state) {
    if (state.mode === MODE_LOCAL) {
      return JSON.stringify({ mode: MODE_LOCAL, repositoryPath: String(state.repositoryPath || "").trim() });
    }
    return JSON.stringify({ mode: MODE_CLONE, repositoryUrl: String(state.repositoryUrl || "").trim() });
  }

  function defaultForm() {
    return {
      mode: MODE_LOCAL,
      goal: "",
      repositoryPath: "",
      repositoryUrl: "",
      trust: false,
      maxWorkers: 4
    };
  }

  class DesktopProjectOnboarding {
    constructor({ rootElement, transport, pollMs = 3000, t = null, runtimeMode = "managed-browser", confirmAction = null } = {}) {
      if (!rootElement) throw new TypeError("desktop_project_onboarding_root_required");
      if (!transport?.query || !transport?.execute) throw new TypeError("desktop_project_onboarding_transport_invalid");
      this.rootElement = rootElement;
      this.transport = transport;
      this.pollMs = Math.max(1000, Number(pollMs) || 3000);
      this.t = typeof t === "function" ? t : (_key, fallback) => fallback;
      this.runtimeMode = String(runtimeMode || "managed-browser");
      this.confirmAction = confirmAction || ((message) => typeof globalThis.confirm === "function" ? globalThis.confirm(message) : false);
      this.project = null;
      this.projects = [];
      this.selectedProjectId = null;
      this.recoveryStatus = "IDLE";
      this.agents = [];
      this.newProjectRequested = false;
      this.busy = false;
      this.lastError = null;
      this.timer = null;
      this.refreshing = false;
      this.formEditing = false;
      this.composing = false;
      this.renderDeferred = false;
      this.preparedRepository = null;
      this.form = defaultForm();
      this.onClick = (event) => this.handleClick(event);
      this.onInput = (event) => this.handleInput(event);
      this.onChange = (event) => this.handleChange(event);
      this.onFocusIn = (event) => this.handleFocusIn(event);
      this.onFocusOut = (event) => this.handleFocusOut(event);
      this.onCompositionStart = (event) => this.handleCompositionStart(event);
      this.onCompositionEnd = (event) => this.handleCompositionEnd(event);
    }

    tr(key, fallback, params = {}) {
      const value = this.t(key, fallback, params);
      return String(value ?? "").replace(/\{([A-Za-z0-9_]+)\}/g, (_match, name) =>
        Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : ""
      );
    }

    setRuntimeMode(mode) {
      this.runtimeMode = String(mode || "managed-browser");
      this.render();
      return this.runtimeMode;
    }

    start() {
      this.rootElement.addEventListener?.("click", this.onClick);
      this.rootElement.addEventListener?.("input", this.onInput);
      this.rootElement.addEventListener?.("change", this.onChange);
      this.rootElement.addEventListener?.("focusin", this.onFocusIn);
      this.rootElement.addEventListener?.("focusout", this.onFocusOut);
      this.rootElement.addEventListener?.("compositionstart", this.onCompositionStart);
      this.rootElement.addEventListener?.("compositionend", this.onCompositionEnd);
      this.refresh();
      this.timer = setInterval(() => this.refresh(), this.pollMs);
      return this;
    }

    stop() {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      this.rootElement.removeEventListener?.("click", this.onClick);
      this.rootElement.removeEventListener?.("input", this.onInput);
      this.rootElement.removeEventListener?.("change", this.onChange);
      this.rootElement.removeEventListener?.("focusin", this.onFocusIn);
      this.rootElement.removeEventListener?.("focusout", this.onFocusOut);
      this.rootElement.removeEventListener?.("compositionstart", this.onCompositionStart);
      this.rootElement.removeEventListener?.("compositionend", this.onCompositionEnd);
    }

    isEditableField(target) {
      return Boolean(target?.dataset?.projectField);
    }

    requestRender() {
      if (this.formEditing || this.composing) {
        this.renderDeferred = true;
        return false;
      }
      this.renderDeferred = false;
      this.render();
      return true;
    }

    async refresh() {
      if (this.refreshing) return;
      this.refreshing = true;
      try {
        const response = await this.transport.query("dashboard", { eventLimit: 1, decisionLimit: 1, minimumSeverity: "warning" });
        if (!response?.ok) throw new Error(response?.reason || "dashboard_query_failed");
        this.project = response.dashboard?.project || null;
        this.agents = Array.isArray(response.dashboard?.agents) ? response.dashboard.agents : [];
        let catalog = null;
        try { catalog = await this.transport.query("projectCatalog", {}); } catch (_) { catalog = null; }
        if (catalog?.ok) {
          this.projects = Array.isArray(catalog.projects) ? catalog.projects : [];
          this.recoveryStatus = String(catalog.recoveryStatus || response.dashboard?.recovery?.status || "IDLE");
          const available = new Set(this.projects.map((item) => String(item.projectId || "")));
          if (!this.selectedProjectId || !available.has(this.selectedProjectId)) {
            this.selectedProjectId = String(catalog.activeProjectId || this.projects[0]?.projectId || "") || null;
          }
        } else {
          this.projects = this.project ? [{
            projectId: this.project.projectId,
            status: this.project.status,
            stage: this.project.stage,
            goal: this.project.goal || "",
            repository: this.project.repository || null,
            active: true
          }] : [];
          this.recoveryStatus = String(response.dashboard?.recovery?.status || "IDLE");
          this.selectedProjectId = this.project?.projectId || null;
        }
      } catch (error) {
        this.lastError = String(error?.message || error || "project_onboarding_refresh_failed");
      } finally {
        this.refreshing = false;
        this.requestRender();
      }
    }

    leadReady() {
      return this.agents.some((agent) => String(agent?.role || "").toLowerCase() === "lead" && agent?.connected === true && String(agent?.status || "") === "IDLE");
    }

    projectLabel(project) {
      const repository = String(project?.repository?.fullName || project?.repository?.repo || "").trim();
      const goal = String(project?.goal || "").trim().replace(/\s+/g, " ");
      const shortGoal = goal.length > 72 ? `${goal.slice(0, 69)}…` : goal;
      return repository && shortGoal ? `${repository} — ${shortGoal}` : (repository || shortGoal || String(project?.projectId || "project"));
    }

    renderProjectManager() {
      if (!this.projects.length && !this.project) return "";
      const activeId = String(this.project?.projectId || this.projects.find((item) => item.active)?.projectId || "");
      const selectedId = String(this.selectedProjectId || activeId || this.projects[0]?.projectId || "");
      const options = this.projects.map((item) => {
        const id = String(item.projectId || "");
        const suffix = item.active ? this.tr("project.currentSuffix", "current") : String(item.status || "");
        return `<option value="${escapeHtml(id)}" ${id === selectedId ? "selected" : ""}>${escapeHtml(this.projectLabel(item))} · ${escapeHtml(suffix)}</option>`;
      }).join("");
      return `<section class="dashboard-section desktop-project-manager">
        <div class="dashboard-section-head"><h3>${escapeHtml(this.tr("project.projects", "Projects"))}</h3><span>${escapeHtml(String(this.projects.length || 1))}</span></div>
        <div class="dashboard-task-controls desktop-project-manager-controls">
          <select data-project-select ${this.busy ? "disabled" : ""}>${options}</select>
          <button class="secondary" data-project-action="switch-project" ${this.busy || !selectedId || selectedId === activeId ? "disabled" : ""}>${escapeHtml(this.tr("project.switch", "Switch"))}</button>
          <button data-project-action="new-project" ${this.busy ? "disabled" : ""}>${escapeHtml(this.tr("project.new", "New project"))}</button>
        </div>
        <p class="dashboard-muted">${escapeHtml(this.tr("project.switchHint", "Each project keeps its own planning, task, review, integration and recovery state. If work is active, Orchestra will ask before stopping it for a project change."))}</p>
      </section>`;
    }

    withProjectManager(content) {
      return `${this.renderProjectManager()}${content || ""}`;
    }

    render() {
      if (this.project && !this.newProjectRequested && TERMINAL_PROJECT_STATUSES.has(String(this.project.status || ""))) {
        this.rootElement.innerHTML = this.withProjectManager(this.renderTerminalProject());
        return;
      }
      if (this.project?.status === "READY" && !this.newProjectRequested) {
        this.rootElement.innerHTML = this.withProjectManager(this.renderExecutionStart());
        return;
      }
      if (this.project && !this.newProjectRequested) {
        const failureReason = String(this.project?.lastError?.reason || "");
        const retryMode = failureReason === "lead_prompt_failed"
          ? "same_run"
          : (this.project?.lastError?.details?.retryMode === "fresh_run" || RETRYABLE_PLANNING_ARTIFACT_FAILURES.has(failureReason) ? "fresh_run" : null);
        const planning = this.project.status === "PLANNING" || Boolean(retryMode);
        const retryablePlanning = Boolean(retryMode);
        const failureDetail = String(this.project?.lastError?.details?.reason || failureReason || "");
        const pausedTitle = retryMode === "fresh_run"
          ? this.tr("project.planningArtifactRejected", "The Lead response needs correction.")
          : this.tr("project.planningPaused", "Planning prompt delivery paused.");
        const retryHint = retryMode === "fresh_run"
          ? this.tr("project.planningArtifactRetryHint", "The response was received, but its planning artifact did not pass validation. Retry starts a fresh run of the same stage and preserves all completed earlier stages.")
          : this.tr("project.planningRetryHint", "The current planning stage was not delivered to the Lead. Retry the same stage and run; completed discovery data will not be discarded.");
        this.rootElement.innerHTML = this.withProjectManager(planning
          ? `<section class="dashboard-section desktop-project-onboarding">
              <div class="dashboard-section-head"><h3>${escapeHtml(this.tr("project.planningTitle", "Planning in progress"))}</h3><span>${escapeHtml(this.project.stage || "PLANNING")}</span></div>
              <p><strong>${escapeHtml(retryablePlanning ? pausedTitle : this.tr("project.planning", "The Lead is planning the project."))}</strong></p>
              <p class="dashboard-muted">${escapeHtml(retryablePlanning
                ? retryHint
                : this.tr("project.planningHint", "Orchestra is inspecting the repository, refining the goal and building a dependency graph. You can follow progress here; execution stays closed until the plan is ready."))}</p>
              ${retryablePlanning ? `<div class="dashboard-error">${escapeHtml(failureDetail)}</div>
                <div class="dashboard-task-controls"><button data-project-action="retry-planning" ${this.busy ? "disabled" : ""}>${escapeHtml(this.busy ? this.tr("project.retrying", "Retrying…") : this.tr("project.retryPlanning", "Retry current planning stage"))}</button></div>` : ""}
              ${this.lastError ? `<div class="dashboard-error">${escapeHtml(this.lastError)}</div>` : ""}
            </section>`
          : "");
        return;
      }

      if (!this.leadReady()) {
        this.rootElement.innerHTML = this.withProjectManager(`<section class="dashboard-section desktop-project-onboarding">
          <div class="dashboard-section-head"><h3>${escapeHtml(this.tr("project.waitingTitle", "Step 2 of 4 — Create the Lead"))}</h3><span>${escapeHtml(this.tr("project.waitingStatus", "WAITING FOR LEAD"))}</span></div>
          ${this.lastError ? `<div class="dashboard-error">${escapeHtml(this.lastError)}</div>` : ""}
          <p><strong>${escapeHtml(this.tr("project.connectLead", "Connect the Lead before starting a project."))}</strong></p>
          <p class="dashboard-muted">${escapeHtml(this.runtimeMode === "companion"
            ? this.tr("project.connectLeadCompanionHint", "In Chrome or Edge, open the Orchestra extension, enable Desktop Companion, then register the signed-in ChatGPT tab as Lead. The project form will appear when the Lead is connected and IDLE.")
            : this.tr("project.connectLeadHint", "Finish ChatGPT sign-in above, wait for the page to become ready, then choose “Register this ChatGPT page as Lead”. The project form will appear automatically when the Lead is connected and IDLE."))}</p>
        </section>`);
        return;
      }

      const local = this.form.mode === MODE_LOCAL;
      const heading = this.newProjectRequested ? this.tr("project.another", "Start another project") : this.tr("project.step3", "Step 3 of 4 — Choose the project");
      this.rootElement.innerHTML = this.withProjectManager(`<section class="dashboard-section desktop-project-onboarding">
        <div class="dashboard-section-head"><h3>${escapeHtml(heading)}</h3><span>${escapeHtml(this.tr("project.ready", "READY"))}</span></div>
        <p><strong>${escapeHtml(this.newProjectRequested ? this.tr("project.another", "Start another project") : this.tr("project.first", "Start your first project"))}</strong></p><p class="dashboard-muted">${escapeHtml(this.tr("project.chooseHint", "Choose a repository and describe the finished result. The Lead will inspect the repository and build a task plan before any Worker starts."))}</p>
        ${this.lastError ? `<div class="dashboard-error">${escapeHtml(this.lastError)}</div>` : ""}
        <div class="dashboard-task-controls">
          <label><input type="radio" name="desktop-project-mode" value="local" data-project-mode="local" ${local ? "checked" : ""} ${this.busy ? "disabled" : ""}> ${escapeHtml(this.tr("project.openLocal", "Open local repository"))}</label>
          <label><input type="radio" name="desktop-project-mode" value="clone" data-project-mode="clone" ${!local ? "checked" : ""} ${this.busy ? "disabled" : ""}> ${escapeHtml(this.tr("project.clone", "Clone repository from URL"))}</label>
        </div>
        <div class="dashboard-evidence">
          ${local ? `
            <label><strong>${escapeHtml(this.tr("project.localRepo", "Local Git repository"))}</strong><br>
              <input type="text" data-project-field="repositoryPath" value="${escapeHtml(this.form.repositoryPath)}" placeholder="C:\\Projects\\MyApp" ${this.busy ? "disabled" : ""}>
            </label>
            <div class="dashboard-task-controls"><button class="secondary" data-project-action="browse" ${this.busy ? "disabled" : ""}>${escapeHtml(this.tr("project.browse", "Browse…"))}</button></div>
            <p class="dashboard-muted">${escapeHtml(this.tr("project.localPrivacy", "The filesystem path stays in the desktop repository registry; portable project state stores only a logical repository id."))}</p>
          ` : ""}
          <label><strong>${escapeHtml(local ? this.tr("project.githubAuto", "GitHub repository URL (auto-detected from origin when possible)") : this.tr("project.github", "GitHub repository URL"))}</strong><br>
            <input type="url" data-project-field="repositoryUrl" value="${escapeHtml(this.form.repositoryUrl)}" placeholder="https://github.com/owner/repository" ${this.busy ? "disabled" : ""}>
          </label>
          ${local ? `<p class="dashboard-muted">${escapeHtml(this.tr("project.githubOptional", "You can leave this blank. Orchestra reads only Git remote origin and accepts a GitHub HTTPS/SSH origin. Enter the canonical URL manually only when the repository has no usable GitHub origin."))}</p>` : ""}
          <label><strong>${escapeHtml(this.tr("project.goal", "What should Orchestra accomplish?"))}</strong><br>
            <textarea rows="5" data-project-field="goal" placeholder="${escapeHtml(this.tr("project.goalPlaceholder", "Describe the finished result, constraints and important acceptance criteria…"))}" ${this.busy ? "disabled" : ""}>${escapeHtml(this.form.goal)}</textarea>
          </label>
          <label class="desktop-project-trust"><input type="checkbox" data-project-trust ${this.form.trust ? "checked" : ""} ${this.busy ? "disabled" : ""}><span>${escapeHtml(this.tr("project.trust", "I trust this repository and allow its structured local verification commands inside isolated Orchestra worktrees."))}</span></label>
        </div>
        <div class="dashboard-task-controls">
          <button data-project-action="start" ${this.busy ? "disabled" : ""}>${escapeHtml(this.busy ? this.tr("project.starting", "Starting…") : this.tr("project.start", "Start planning"))}</button>
        </div>
      </section>`);
    }

    renderExecutionStart() {
      return `<section class="dashboard-section desktop-project-onboarding">
        <div class="dashboard-section-head"><h3>${escapeHtml(this.tr("project.step4", "Step 4 of 4 — Start execution"))}</h3><span>${escapeHtml(this.tr("project.ready", "READY"))}</span></div>
        ${this.lastError ? `<div class="dashboard-error">${escapeHtml(this.lastError)}</div>` : ""}
        <p><strong>${escapeHtml(this.tr("project.taskDagReady", "The task plan is ready."))}</strong></p><p class="dashboard-muted">${escapeHtml(this.tr("project.executeHint", "Choose how many Workers may run simultaneously. Workers use isolated Git worktrees; completed changes still require independent review before integration."))}</p>
        <div class="dashboard-task-controls">
          <label>${escapeHtml(this.tr("project.workers", "Workers"))}
            <select data-project-workers ${this.busy ? "disabled" : ""}>
              ${[1, 2, 3, 4].map((count) => `<option value="${count}" ${Number(this.form.maxWorkers) === count ? "selected" : ""}>${count}</option>`).join("")}
            </select>
          </label>
          <button data-project-action="execute" ${this.busy ? "disabled" : ""}>${escapeHtml(this.busy ? this.tr("project.starting", "Starting…") : this.tr("project.execute", "Start execution"))}</button>
        </div>
        
      </section>`;
    }

    renderTerminalProject() {
      const status = String(this.project?.status || "COMPLETE");
      const verified = status === "INTEGRATION_VERIFIED";
      return `<section class="dashboard-section desktop-project-onboarding">
        <div class="dashboard-section-head"><h3>${escapeHtml(verified ? this.tr("project.complete", "Project complete") : this.tr("project.ended", "Project ended"))}</h3><span>${escapeHtml(status)}</span></div>
        ${this.lastError ? `<div class="dashboard-error">${escapeHtml(this.lastError)}</div>` : ""}
        <p><strong>${escapeHtml(verified ? this.tr("project.integrationVerified", "Integration is verified.") : this.tr("project.noLongerRunning", "This project is no longer running."))}</strong></p>
        <p class="dashboard-muted">${escapeHtml(this.tr("project.historyHint", "The previous project remains persisted for audit/export. Starting another project only changes which project is active."))}</p>
        <div class="dashboard-task-controls"><button data-project-action="new-project">${escapeHtml(this.tr("project.another", "Start another project"))}</button></div>
      </section>`;
    }

    resetForNewProject() {
      this.newProjectRequested = true;
      this.preparedRepository = null;
      this.form = defaultForm();
      this.lastError = null;
      this.render();
      return { ok: true };
    }

    setError(reason) {
      this.lastError = String(reason || "unknown_error");
      this.render();
      return { ok: false, reason: this.lastError };
    }

    async browse() {
      if (typeof this.transport.selectRepositoryDirectory !== "function") return this.setError("desktop_directory_picker_unavailable");
      const selected = await this.transport.selectRepositoryDirectory();
      if (selected?.cancelled) return selected;
      if (!selected?.ok || !selected.path) return this.setError(selected?.reason || "repository_directory_selection_failed");
      this.form.repositoryPath = selected.path;
      this.preparedRepository = null;
      this.lastError = null;
      this.render();
      return selected;
    }

    validateForm() {
      const goal = String(this.form.goal || "").trim();
      const repositoryUrl = String(this.form.repositoryUrl || "").trim();
      const repositoryPath = String(this.form.repositoryPath || "").trim();
      if (goal.length < 10) return { ok: false, reason: this.tr("project.error.goal", "Goal must be at least 10 characters.") };
      if (this.form.mode === MODE_LOCAL && !repositoryPath) return { ok: false, reason: this.tr("project.error.path", "Choose a local Git repository first.") };
      if (repositoryUrl && !normalizeGitHubUrl(repositoryUrl)) return { ok: false, reason: this.tr("project.error.github", "Use a GitHub repository URL like https://github.com/owner/repository.") };
      if (this.form.mode === MODE_CLONE && !normalizeGitHubUrl(repositoryUrl)) return { ok: false, reason: this.tr("project.error.github", "Use a GitHub repository URL like https://github.com/owner/repository.") };
      return { ok: true, goal, repositoryUrl, repositoryPath };
    }

    async prepareRepository(validated) {
      const key = repositoryPreparationKey(this.form);
      if (this.preparedRepository?.key === key) return { ok: true, ...this.preparedRepository };
      const repositoryId = createRepositoryId();
      const response = this.form.mode === MODE_LOCAL
        ? await this.transport.execute("openLocalRepository", { repositoryId, path: validated.repositoryPath })
        : await this.transport.execute("cloneRepository", { repositoryId, url: validated.repositoryUrl });
      if (!response?.ok) return response || { ok: false, reason: "repository_prepare_failed" };
      const repositoryUrl = normalizeGitHubUrl(response.repositoryUrl) || normalizeGitHubUrl(validated.repositoryUrl) || null;
      if (this.form.mode === MODE_LOCAL && repositoryUrl && !this.form.repositoryUrl) this.form.repositoryUrl = repositoryUrl;
      this.preparedRepository = { key, repositoryId, repositoryUrl };
      return { ok: true, repositoryId, repositoryUrl };
    }

    async startProject() {
      if (!this.leadReady()) return this.setError(this.tr("project.error.lead", "Connect the Lead and wait for it to become IDLE before starting a project."));
      const validated = this.validateForm();
      if (!validated.ok) return this.setError(validated.reason);
      this.busy = true;
      this.lastError = null;
      this.render();
      try {
        const prepared = await this.prepareRepository(validated);
        if (!prepared?.ok) return this.setError(prepared?.reason || "repository_prepare_failed");
        const repositoryUrl = normalizeGitHubUrl(validated.repositoryUrl) || normalizeGitHubUrl(prepared.repositoryUrl) || null;
        if (!repositoryUrl) {
          return this.setError(this.tr("project.error.noOrigin", "No GitHub origin was detected. Enter the repository GitHub URL and press Start planning again."));
        }
        if (this.form.trust) {
          const trusted = await this.transport.execute("setRepositoryTrust", { repositoryId: prepared.repositoryId, trust: "TRUSTED" });
          if (!trusted?.ok) return this.setError(trusted?.reason || "repository_trust_failed");
        }
        const started = await this.transport.execute("startProject", {
          goal: validated.goal,
          repositoryUrl,
          repositoryId: prepared.repositoryId
        });
        if (!started?.ok) return this.setError(started?.reason || "project_start_failed");
        this.newProjectRequested = false;
        this.lastError = null;
        await this.refresh();
        return started;
      } catch (error) {
        return this.setError(error?.message || error || "project_start_failed");
      } finally {
        this.busy = false;
        this.render();
      }
    }

    async ensureProjectChangeBoundary() {
      if (!this.project || SAFE_PROJECT_CHANGE_STATES.has(String(this.recoveryStatus || "IDLE"))) return { ok: true };
      const confirmed = this.confirmAction(this.tr(
        "project.stopConfirm",
        "Current work must be stopped before changing projects. Stop the current project now?"
      ));
      if (!confirmed) return { ok: false, cancelled: true };
      const stopped = await this.transport.execute("stopNow", {});
      if (!stopped?.ok) return this.setError(stopped?.reason || "project_stop_failed");
      this.recoveryStatus = String(stopped.recovery?.status || "STOPPED");
      if (!SAFE_PROJECT_CHANGE_STATES.has(this.recoveryStatus)) {
        return this.setError(this.tr("project.error.notSafe", "Project change is not safe yet. Wait for Stop/Pause to finish and try again."));
      }
      return { ok: true };
    }

    async completeProjectChange(command, payload = {}) {
      this.busy = true;
      this.lastError = null;
      this.render();
      try {
        const boundary = await this.ensureProjectChangeBoundary();
        if (!boundary?.ok) return boundary;
        const response = await this.transport.execute(command, payload);
        if (!response?.ok) return this.setError(response?.reason || "project_change_failed");
        if (response.reloadRequired) {
          if (typeof this.transport.restartApplication !== "function") return this.setError(this.tr("project.error.restartUnavailable", "Project state changed, but application restart is unavailable. Restart Orchestra manually."));
          const restarted = await this.transport.restartApplication();
          if (!restarted?.ok) return this.setError(this.tr("project.error.restart", "Project state changed, but Orchestra could not restart: {reason}", { reason: restarted?.reason || "desktop_restart_failed" }));
        }
        return response;
      } catch (error) {
        return this.setError(error?.message || error || "project_change_failed");
      } finally {
        this.busy = false;
        this.render();
      }
    }

    async startNewProject() {
      return this.completeProjectChange("prepareNewProject", {});
    }

    async switchProject() {
      const projectId = String(this.selectedProjectId || "");
      if (!projectId || projectId === String(this.project?.projectId || "")) return { ok: true, alreadyActive: true };
      return this.completeProjectChange("switchProject", { projectId });
    }

    async retryPlanning() {
      this.busy = true;
      this.lastError = null;
      this.render();
      try {
        const response = await this.transport.execute("retryPlanning", {});
        if (!response?.ok) return this.setError(response?.reason || "planning_retry_failed");
        await this.refresh();
        return response;
      } catch (error) {
        return this.setError(error?.message || error || "planning_retry_failed");
      } finally {
        this.busy = false;
        this.render();
      }
    }

    async startExecution() {
      this.busy = true;
      this.lastError = null;
      this.render();
      try {
        const response = await this.transport.execute("startExecution", { maxWorkers: Number(this.form.maxWorkers) || 4 });
        if (!response?.ok) return this.setError(response?.reason || "execution_start_failed");
        await this.refresh();
        return response;
      } catch (error) {
        return this.setError(error?.message || error || "execution_start_failed");
      } finally {
        this.busy = false;
        this.render();
      }
    }

    handleFocusIn(event) {
      if (!this.isEditableField(event.target)) return;
      this.formEditing = true;
    }

    handleFocusOut(event) {
      if (!this.isEditableField(event.target)) return;
      this.formEditing = false;
      if (this.renderDeferred && !this.composing) this.requestRender();
    }

    handleCompositionStart(event) {
      if (!this.isEditableField(event.target)) return;
      this.composing = true;
      this.formEditing = true;
    }

    handleCompositionEnd(event) {
      if (!this.isEditableField(event.target)) return;
      this.composing = false;
    }

    handleInput(event) {
      const field = event.target?.dataset?.projectField;
      if (!field || !Object.prototype.hasOwnProperty.call(this.form, field)) return;
      this.form[field] = event.target.value || "";
      if (field === "repositoryPath" || (field === "repositoryUrl" && this.form.mode === MODE_CLONE)) this.preparedRepository = null;
    }

    handleChange(event) {
      if (event.target?.hasAttribute?.("data-project-select") || event.target?.dataset?.projectSelect !== undefined) {
        this.selectedProjectId = String(event.target.value || "") || null;
        this.render();
        return;
      }
      const mode = event.target?.dataset?.projectMode;
      if (mode && PROJECT_MODES.has(mode)) {
        this.form.mode = mode;
        this.preparedRepository = null;
        this.lastError = null;
        this.render();
        return;
      }
      if (event.target?.hasAttribute?.("data-project-trust") || event.target?.dataset?.projectTrust !== undefined) {
        this.form.trust = Boolean(event.target.checked);
        return;
      }
      if (event.target?.hasAttribute?.("data-project-workers") || event.target?.dataset?.projectWorkers !== undefined) {
        this.form.maxWorkers = Math.max(1, Math.min(4, Number(event.target.value) || 4));
      }
    }

    handleClick(event) {
      const button = event.target?.closest?.("[data-project-action]");
      if (!button || button.disabled) return;
      const action = button.dataset.projectAction;
      if (action === "browse") return this.browse();
      if (action === "start") return this.startProject();
      if (action === "retry-planning") return this.retryPlanning();
      if (action === "execute") return this.startExecution();
      if (action === "switch-project") return this.switchProject();
      if (action === "new-project") return this.startNewProject();
    }
  }

  root.DesktopProjectOnboarding = DesktopProjectOnboarding;
  if (typeof module !== "undefined" && module.exports) module.exports = {
    DesktopProjectOnboarding,
    MODE_LOCAL,
    MODE_CLONE,
    TERMINAL_PROJECT_STATUSES,
    SAFE_PROJECT_CHANGE_STATES,
    normalizeGitHubUrl,
    createRepositoryId,
    repositoryPreparationKey,
    defaultForm
  };
})();
