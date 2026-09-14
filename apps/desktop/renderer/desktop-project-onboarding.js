(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};
  const MODE_LOCAL = "local";
  const MODE_CLONE = "clone";
  const PROJECT_MODES = new Set([MODE_LOCAL, MODE_CLONE]);

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

  class DesktopProjectOnboarding {
    constructor({ rootElement, transport, pollMs = 3000 } = {}) {
      if (!rootElement) throw new TypeError("desktop_project_onboarding_root_required");
      if (!transport?.query || !transport?.execute) throw new TypeError("desktop_project_onboarding_transport_invalid");
      this.rootElement = rootElement;
      this.transport = transport;
      this.pollMs = Math.max(1000, Number(pollMs) || 3000);
      this.project = null;
      this.busy = false;
      this.lastError = null;
      this.timer = null;
      this.refreshing = false;
      this.preparedRepository = null;
      this.form = {
        mode: MODE_LOCAL,
        goal: "",
        repositoryPath: "",
        repositoryUrl: "",
        trust: false,
        maxWorkers: 4
      };
      this.onClick = (event) => this.handleClick(event);
      this.onInput = (event) => this.handleInput(event);
      this.onChange = (event) => this.handleChange(event);
    }

    start() {
      this.rootElement.addEventListener?.("click", this.onClick);
      this.rootElement.addEventListener?.("input", this.onInput);
      this.rootElement.addEventListener?.("change", this.onChange);
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
    }

    async refresh() {
      if (this.refreshing) return;
      this.refreshing = true;
      try {
        const response = await this.transport.query("dashboard", { eventLimit: 1, decisionLimit: 1, minimumSeverity: "warning" });
        if (!response?.ok) throw new Error(response?.reason || "dashboard_query_failed");
        this.project = response.dashboard?.project || null;
      } catch (error) {
        this.lastError = String(error?.message || error || "project_onboarding_refresh_failed");
      } finally {
        this.refreshing = false;
        this.render();
      }
    }

    render() {
      if (this.project?.status === "READY") {
        this.rootElement.innerHTML = this.renderExecutionStart();
        return;
      }
      if (this.project) {
        const planning = this.project.status === "PLANNING";
        this.rootElement.innerHTML = planning
          ? `<section class="dashboard-section desktop-project-onboarding">
              <div class="dashboard-section-head"><h3>Project startup</h3><span>${escapeHtml(this.project.stage || "PLANNING")}</span></div>
              <p><strong>Lead is planning the project.</strong></p>
              <p class="dashboard-muted">Orchestra is inspecting the repository, refining the plan and building the task DAG. Execution controls will appear when planning reaches READY.</p>
              ${this.lastError ? `<div class="dashboard-error">${escapeHtml(this.lastError)}</div>` : ""}
            </section>`
          : "";
        return;
      }

      const local = this.form.mode === MODE_LOCAL;
      this.rootElement.innerHTML = `<section class="dashboard-section desktop-project-onboarding">
        <div class="dashboard-section-head"><h3>Start your first project</h3><span>Phase 20</span></div>
        <p class="dashboard-muted">Choose a repository, describe the outcome you want, then Orchestra will ask the registered Lead to plan the work.</p>
        ${this.lastError ? `<div class="dashboard-error">${escapeHtml(this.lastError)}</div>` : ""}
        <div class="dashboard-task-controls">
          <label><input type="radio" name="desktop-project-mode" value="local" data-project-mode="local" ${local ? "checked" : ""} ${this.busy ? "disabled" : ""}> Open local repository</label>
          <label><input type="radio" name="desktop-project-mode" value="clone" data-project-mode="clone" ${!local ? "checked" : ""} ${this.busy ? "disabled" : ""}> Clone repository from URL</label>
        </div>
        <div class="dashboard-evidence">
          ${local ? `
            <label><strong>Local Git repository</strong><br>
              <input type="text" data-project-field="repositoryPath" value="${escapeHtml(this.form.repositoryPath)}" placeholder="C:\\Projects\\MyApp" ${this.busy ? "disabled" : ""}>
            </label>
            <div class="dashboard-task-controls"><button class="secondary" data-project-action="browse" ${this.busy ? "disabled" : ""}>Browse…</button></div>
            <p class="dashboard-muted">The filesystem path stays in the desktop repository registry; portable project state stores only a logical repository id.</p>
          ` : ""}
          <label><strong>${local ? "GitHub repository URL (auto-detected from origin when possible)" : "GitHub repository URL"}</strong><br>
            <input type="url" data-project-field="repositoryUrl" value="${escapeHtml(this.form.repositoryUrl)}" placeholder="https://github.com/owner/repository" ${this.busy ? "disabled" : ""}>
          </label>
          ${local ? `<p class="dashboard-muted">You can leave this blank. Orchestra reads only Git remote <code>origin</code> and accepts a GitHub HTTPS/SSH origin. Enter the canonical URL manually only when the repository has no usable GitHub origin.</p>` : ""}
          <label><strong>Goal</strong><br>
            <textarea rows="5" data-project-field="goal" placeholder="Describe the finished result, constraints and important acceptance criteria…" ${this.busy ? "disabled" : ""}>${escapeHtml(this.form.goal)}</textarea>
          </label>
          <label><input type="checkbox" data-project-trust ${this.form.trust ? "checked" : ""} ${this.busy ? "disabled" : ""}> I trust this repository and allow its structured local verification commands inside isolated Orchestra worktrees.</label>
        </div>
        <div class="dashboard-task-controls">
          <button data-project-action="start" ${this.busy ? "disabled" : ""}>${this.busy ? "Starting…" : "Start Project"}</button>
        </div>
      </section>`;
    }

    renderExecutionStart() {
      return `<section class="dashboard-section desktop-project-onboarding">
        <div class="dashboard-section-head"><h3>Planning complete</h3><span>READY</span></div>
        ${this.lastError ? `<div class="dashboard-error">${escapeHtml(this.lastError)}</div>` : ""}
        <p><strong>The task DAG is ready.</strong> Choose the maximum Worker concurrency and start execution.</p>
        <div class="dashboard-task-controls">
          <label>Workers
            <select data-project-workers ${this.busy ? "disabled" : ""}>
              ${[1, 2, 3, 4].map((count) => `<option value="${count}" ${Number(this.form.maxWorkers) === count ? "selected" : ""}>${count}</option>`).join("")}
            </select>
          </label>
          <button data-project-action="execute" ${this.busy ? "disabled" : ""}>${this.busy ? "Starting…" : "Start Execution"}</button>
        </div>
        <p class="dashboard-muted">Workers run in isolated Git worktrees. Mutating tasks still require independent review before dependencies unlock and before integration.</p>
      </section>`;
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
      if (goal.length < 10) return { ok: false, reason: "Goal must be at least 10 characters." };
      if (this.form.mode === MODE_LOCAL && !repositoryPath) return { ok: false, reason: "Choose a local Git repository first." };
      if (repositoryUrl && !normalizeGitHubUrl(repositoryUrl)) return { ok: false, reason: "Use a GitHub repository URL like https://github.com/owner/repository." };
      if (this.form.mode === MODE_CLONE && !normalizeGitHubUrl(repositoryUrl)) return { ok: false, reason: "Use a GitHub repository URL like https://github.com/owner/repository." };
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
          return this.setError("No GitHub origin was detected. Enter the repository GitHub URL and press Start Project again.");
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

    handleInput(event) {
      const field = event.target?.dataset?.projectField;
      if (!field || !Object.prototype.hasOwnProperty.call(this.form, field)) return;
      this.form[field] = event.target.value || "";
      if (field === "repositoryPath" || (field === "repositoryUrl" && this.form.mode === MODE_CLONE)) this.preparedRepository = null;
    }

    handleChange(event) {
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
      if (action === "execute") return this.startExecution();
    }
  }

  root.DesktopProjectOnboarding = DesktopProjectOnboarding;
  if (typeof module !== "undefined" && module.exports) module.exports = {
    DesktopProjectOnboarding,
    MODE_LOCAL,
    MODE_CLONE,
    normalizeGitHubUrl,
    createRepositoryId,
    repositoryPreparationKey
  };
})();
