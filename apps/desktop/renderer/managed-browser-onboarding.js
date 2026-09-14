(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  }

  function downloadJson(filename, text) {
    if (!globalThis.document || !globalThis.URL || !globalThis.Blob) return false;
    const blob = new Blob([String(text || "")], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename || "chatgpt-orchestra-managed-browser-validation.json";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  }

  const VALIDATION_LABELS = Object.freeze({
    chatgptReady: "ChatGPT page ready",
    leadRegistered: "Lead registered",
    assistantCompletionObserved: "Direct assistant completion observed",
    projectStarted: "Reference project started",
    planningCompleted: "Planning completed",
    parallelWorkersObserved: "Parallel Worker runs observed",
    dependencyGraphObserved: "Dependency graph exercised",
    independentReviewObserved: "Independent Review observed",
    integrationVerified: "Integration verified",
    sessionRecoveryObserved: "Session loss and recovery observed",
    recoveryHealthy: "Recovery state healthy"
  });

  class ManagedBrowserOnboarding {
    constructor({ rootElement, transport, pollMs = 2500, download = downloadJson } = {}) {
      if (!rootElement) throw new TypeError("managed_browser_onboarding_root_required");
      if (!transport?.query || !transport?.execute) throw new TypeError("managed_browser_onboarding_transport_invalid");
      this.rootElement = rootElement;
      this.transport = transport;
      this.pollMs = Math.max(1000, Number(pollMs) || 2500);
      this.download = download;
      this.status = null;
      this.validation = null;
      this.timer = null;
      this.refreshing = false;
      this.onClick = (event) => this.handleClick(event);
    }

    start() {
      this.rootElement.addEventListener?.("click", this.onClick);
      this.refresh();
      this.timer = setInterval(() => this.refresh(), this.pollMs);
      return this;
    }

    stop() {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      this.rootElement.removeEventListener?.("click", this.onClick);
    }

    async refresh() {
      if (this.refreshing) return;
      this.refreshing = true;
      try {
        const response = await this.transport.query("managedBrowserStatus", {});
        if (!response?.ok) {
          if (["unknown_api_query", "api_dependency_unavailable"].includes(String(response?.reason || ""))) {
            this.status = null;
            this.validation = null;
            return;
          }
          throw new Error(response?.reason || "managed_browser_status_failed");
        }
        this.status = response.managedBrowser || null;
        this.validation = null;
        const validationResponse = await this.transport.query("managedBrowserValidation", {});
        if (validationResponse?.ok && validationResponse.validation) this.validation = validationResponse.validation;
      } catch (_) {
        this.status = null;
        this.validation = null;
      } finally {
        this.refreshing = false;
        this.render();
      }
    }

    renderValidation() {
      const validation = this.validation;
      if (!validation) return "";
      const checks = validation.checks || {};
      const rows = Object.entries(VALIDATION_LABELS).map(([key, label]) => (
        `<li><strong>${checks[key] ? "✓" : "○"}</strong> ${escapeHtml(label)}</li>`
      )).join("");
      return `<div class="dashboard-evidence managed-browser-validation">
        <div class="dashboard-section-head"><strong>Live validation evidence</strong><span>${validation.complete ? "COMPLETE" : "IN PROGRESS"}</span></div>
        <ul>${rows}</ul>
        <p class="dashboard-muted">This evidence contains only aggregate state and counters; browser URLs, session/page identifiers, prompts, responses and credentials are excluded.</p>
        <button class="secondary" data-managed-browser-action="export-validation">Export validation evidence</button>
      </div>`;
    }

    render() {
      const status = this.status;
      if (!status) {
        this.rootElement.innerHTML = "";
        return;
      }
      const availability = String(status.availability || "unavailable");
      const lead = status.leadRegistered
        ? `<strong>Lead connected</strong> · ${escapeHtml(status.leadStatus || "UNKNOWN")}`
        : status.loginRequired
          ? `<strong>Login required</strong> · ${escapeHtml(availability)}`
          : `<strong>ChatGPT ready</strong> · Lead not registered`;
      const action = status.loginRequired
        ? `<button data-managed-browser-action="open">Open / Login to ChatGPT</button>`
        : status.leadRegistered
          ? `<button class="secondary" data-managed-browser-action="open">Open ChatGPT</button>`
          : `<button data-managed-browser-action="register">Register this ChatGPT page as Lead</button>`;
      this.rootElement.innerHTML = `<section class="dashboard-section managed-browser-onboarding">
        <div class="dashboard-section-head"><h3>Direct Desktop ChatGPT</h3><span>${escapeHtml(availability)}</span></div>
        <p>${lead}</p>
        <p class="dashboard-muted">Sign in only inside Orchestra's isolated browser profile. ChatGPT credentials and cookies are not copied into Orchestra state.</p>
        <div class="dashboard-task-controls">
          ${action}
          <button class="secondary" data-managed-browser-action="refresh">Refresh status</button>
        </div>
        ${this.renderValidation()}
      </section>`;
    }

    async handleAction(action) {
      const normalized = String(action || "");
      if (normalized === "refresh") return this.refresh();
      if (normalized === "open") {
        await this.transport.execute("openManagedBrowser", {});
        return this.refresh();
      }
      if (normalized === "register") {
        const result = await this.transport.execute("registerManagedBrowserLead", {});
        await this.refresh();
        return result;
      }
      if (normalized === "export-validation") {
        const result = await this.transport.execute("exportManagedBrowserValidation", {});
        if (result?.ok && result.serialized) this.download(result.filename, result.serialized);
        return result;
      }
      return null;
    }

    handleClick(event) {
      const button = event.target?.closest?.("[data-managed-browser-action]");
      if (!button || button.disabled) return;
      return this.handleAction(button.dataset.managedBrowserAction);
    }
  }

  root.ManagedBrowserOnboarding = ManagedBrowserOnboarding;
  if (typeof module !== "undefined" && module.exports) module.exports = { ManagedBrowserOnboarding, VALIDATION_LABELS, downloadJson };
})();
