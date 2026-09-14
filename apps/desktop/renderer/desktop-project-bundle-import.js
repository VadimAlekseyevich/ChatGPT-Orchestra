(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};
  const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;
  const SAFE_IMPORT_STATES = new Set(["IDLE", "PAUSED", "STOPPED", "RECOVERY_REQUIRED"]);

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  }

  class DesktopProjectBundleImport {
    constructor({ rootElement, transport, pollMs = 3000, confirmAction = null } = {}) {
      if (!rootElement) throw new TypeError("desktop_project_bundle_import_root_required");
      if (!transport?.query || !transport?.execute) throw new TypeError("desktop_project_bundle_import_transport_invalid");
      this.rootElement = rootElement;
      this.transport = transport;
      this.pollMs = Math.max(1000, Number(pollMs) || 3000);
      this.confirmAction = confirmAction || ((message) => typeof globalThis.confirm === "function" ? globalThis.confirm(message) : false);
      this.project = null;
      this.recoveryStatus = "IDLE";
      this.busy = false;
      this.lastError = null;
      this.notice = null;
      this.timer = null;
      this.refreshing = false;
      this.onClick = (event) => this.handleClick(event);
      this.onChange = (event) => this.handleChange(event);
    }

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

    canImport() {
      return SAFE_IMPORT_STATES.has(String(this.recoveryStatus || "IDLE"));
    }

    async refresh() {
      if (this.refreshing || this.busy) return;
      this.refreshing = true;
      try {
        const response = await this.transport.query("dashboard", { eventLimit: 1, decisionLimit: 1, minimumSeverity: "warning" });
        if (!response?.ok) throw new Error(response?.reason || "dashboard_query_failed");
        this.project = response.dashboard?.project || null;
        this.recoveryStatus = String(response.dashboard?.recovery?.status || "IDLE");
        this.lastError = null;
      } catch (error) {
        this.lastError = String(error?.message || error || "project_bundle_import_refresh_failed");
      } finally {
        this.refreshing = false;
        this.render();
      }
    }

    render() {
      const allowed = this.canImport();
      const projectLabel = this.project?.projectId ? `Current project: ${this.project.projectId}` : "No active project";
      this.rootElement.innerHTML = `<section class="dashboard-section desktop-project-bundle-import">
        <div class="dashboard-section-head"><h3>Project Bundle</h3><span>${escapeHtml(this.recoveryStatus)}</span></div>
        <p class="dashboard-muted">Import a portable Orchestra Project Bundle. The bundle is validated before mutation; browser/runtime identities and secrets are not restored.</p>
        ${this.lastError ? `<div class="dashboard-error">${escapeHtml(this.lastError)}</div>` : ""}
        ${this.notice ? `<div class="dashboard-evidence"><strong>${escapeHtml(this.notice)}</strong></div>` : ""}
        <div class="dashboard-task-controls">
          <button class="secondary" data-project-bundle-action="import" ${this.busy || !allowed ? "disabled" : ""}>${this.busy ? "Importing…" : "Import Project Bundle"}</button>
          <small>${escapeHtml(projectLabel)} · import ${allowed ? "allowed" : "blocked until Pause/Stop/recovery safe point"}</small>
        </div>
        <input type="file" accept="application/json,.json" data-project-bundle-file hidden>
      </section>`;
    }

    setError(reason) {
      this.lastError = String(reason || "unknown_error");
      this.notice = null;
      this.render();
      return { ok: false, reason: this.lastError };
    }

    async importFile(file) {
      if (!file) return { ok: false, cancelled: true };
      if (!this.canImport()) return this.setError(`Project Bundle import is not allowed while recovery is ${this.recoveryStatus}. Pause or Stop the project first.`);
      if (Number(file.size) > MAX_BUNDLE_BYTES) return this.setError("Project Bundle is larger than 8 MiB.");
      if (this.project) {
        const confirmed = this.confirmAction("Importing this Project Bundle will replace the current portable project state after Orchestra creates a backup. Continue?");
        if (!confirmed) return { ok: false, cancelled: true };
      }

      this.busy = true;
      this.lastError = null;
      this.notice = null;
      this.render();
      try {
        let serialized;
        try { serialized = await file.text(); }
        catch (_) { return this.setError("Unable to read the selected Project Bundle."); }
        if (new TextEncoder().encode(String(serialized || "")).length > MAX_BUNDLE_BYTES) return this.setError("Project Bundle is larger than 8 MiB.");

        const response = await this.transport.execute("importProjectBundle", {
          bundle: String(serialized || ""),
          replace: Boolean(this.project)
        });
        if (!response?.ok) return this.setError(`Import failed: ${response?.reason || "unknown_error"}`);

        this.notice = `Imported ${response.projectId || "project"}. Restarting Orchestra for reconciliation…`;
        this.render();
        if (response.reloadRequired) {
          if (typeof this.transport.restartApplication !== "function") return this.setError("Import succeeded but desktop restart capability is unavailable. Restart Orchestra manually before continuing.");
          const restarted = await this.transport.restartApplication();
          if (!restarted?.ok) return this.setError(`Import succeeded but restart failed: ${restarted?.reason || "desktop_restart_failed"}. Restart Orchestra manually before continuing.`);
        }
        return response;
      } catch (error) {
        return this.setError(error?.message || error || "project_bundle_import_failed");
      } finally {
        this.busy = false;
        this.render();
      }
    }

    handleClick(event) {
      const button = event.target?.closest?.("[data-project-bundle-action]");
      if (!button || button.disabled) return;
      if (button.dataset.projectBundleAction === "import") this.rootElement.querySelector?.("[data-project-bundle-file]")?.click?.();
    }

    async handleChange(event) {
      if (!event.target?.hasAttribute?.("data-project-bundle-file") && event.target?.dataset?.projectBundleFile === undefined) return;
      const file = event.target.files?.[0] || null;
      event.target.value = "";
      return this.importFile(file);
    }
  }

  root.DesktopProjectBundleImport = DesktopProjectBundleImport;
  if (typeof module !== "undefined" && module.exports) module.exports = {
    DesktopProjectBundleImport,
    MAX_BUNDLE_BYTES,
    SAFE_IMPORT_STATES
  };
})();
