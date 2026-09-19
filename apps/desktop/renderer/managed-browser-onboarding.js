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
    constructor({ rootElement, transport, pollMs = 2500, download = downloadJson, t = null } = {}) {
      if (!rootElement) throw new TypeError("managed_browser_onboarding_root_required");
      if (!transport?.query || !transport?.execute) throw new TypeError("managed_browser_onboarding_transport_invalid");
      this.rootElement = rootElement;
      this.transport = transport;
      this.pollMs = Math.max(1000, Number(pollMs) || 2500);
      this.download = download;
      this.t = typeof t === "function" ? t : (_key, fallback) => fallback;
      this.status = null;
      this.validation = null;
      this.timer = null;
      this.refreshing = false;
      this.fallbackError = null;
      this.onClick = (event) => this.handleClick(event);
    }

    tr(key, fallback, params = {}) {
      const value = this.t(key, fallback, params);
      return String(value ?? "").replace(/\{([A-Za-z0-9_]+)\}/g, (_match, name) =>
        Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : ""
      );
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
      const rows = Object.entries(VALIDATION_LABELS).map(([key, fallback]) => (
        `<li><strong>${checks[key] ? "✓" : "○"}</strong> ${escapeHtml(this.tr(`managed.check.${key}`, fallback))}</li>`
      )).join("");
      const state = validation.complete
        ? this.tr("managed.complete", "COMPLETE")
        : this.tr("managed.inProgress", "IN PROGRESS");
      return `<details class="dashboard-evidence managed-browser-validation">
        <summary><strong>${escapeHtml(this.tr("managed.diagnostics", "Diagnostics / alpha validation"))}</strong> · ${escapeHtml(state)}</summary>
        <div class="managed-browser-validation-body">
          <div class="dashboard-section-head"><strong>${escapeHtml(this.tr("managed.validation", "Live validation evidence"))}</strong><span>${escapeHtml(state)}</span></div>
          <ul>${rows}</ul>
          <p class="dashboard-muted">${escapeHtml(this.tr("managed.validationPrivacy", "This evidence contains only aggregate state and counters; browser URLs, session/page identifiers, prompts, responses and credentials are excluded."))}</p>
          <button class="secondary" data-managed-browser-action="export-validation">${escapeHtml(this.tr("managed.exportValidation", "Export validation evidence"))}</button>
        </div>
      </details>`;
    }

    renderUnsupportedAuth(status) {
      if (status?.unsupportedAuthProvider !== "google") return "";
      return `<div class="dashboard-error managed-auth-fallback">
        <strong>${escapeHtml(this.tr("managed.googleUnsupportedTitle", "Google sign-in must continue in Chrome or Edge"))}</strong>
        <p>${escapeHtml(this.tr("managed.googleUnsupportedText", "Google does not allow this sign-in inside the embedded Electron browser. Orchestra opened the provider in your normal browser and can switch to its extension/companion fallback without copying credentials or cookies."))}</p>
        ${this.fallbackError ? `<p>${escapeHtml(this.fallbackError === "companion_fallback_requires_packaged_runtime" ? this.tr("managed.packagedFallbackRequired", "This fallback must be prepared from the packaged Windows candidate. Build it, launch the packaged executable, then try again.") : this.fallbackError)}</p>` : ""}
        <div class="dashboard-task-controls">
          <button data-managed-browser-action="use-companion">${escapeHtml(this.tr("managed.useCompanion", "Prepare and use Chrome / Edge fallback"))}</button>
          <button class="secondary" data-managed-browser-action="open-external">${escapeHtml(this.tr("managed.openExternal", "Open ChatGPT in normal browser"))}</button>
          <button class="secondary" data-managed-browser-action="open">${escapeHtml(this.tr("managed.otherMethod", "Use another sign-in method"))}</button>
        </div>
      </div>`;
    }

    render() {
      const status = this.status;
      if (!status) {
        this.rootElement.innerHTML = "";
        return;
      }
      const availability = String(status.availability || "unavailable");
      const title = status.leadRegistered
        ? this.tr("managed.connected", "ChatGPT connected")
        : status.loginRequired
          ? this.tr("managed.step1", "Step 1 of 4 — Connect ChatGPT")
          : this.tr("managed.step2", "Step 2 of 4 — Create the Lead");
      const lead = status.leadRegistered
        ? `<strong>${escapeHtml(this.tr("managed.leadConnected", "Lead connected"))}</strong> · ${escapeHtml(status.leadStatus || "UNKNOWN")}`
        : status.loginRequired
          ? `<strong>${escapeHtml(this.tr("managed.loginRequired", "Login required"))}</strong> · ${escapeHtml(availability)}`
          : `<strong>${escapeHtml(this.tr("managed.readyNoLead", "ChatGPT is ready. Register this page as the Lead."))}</strong>`;
      const action = status.loginRequired
        ? `<button data-managed-browser-action="open">${escapeHtml(this.tr("managed.openLogin", "Open / Login to ChatGPT"))}</button>`
        : status.leadRegistered
          ? `<button class="secondary" data-managed-browser-action="open">${escapeHtml(this.tr("managed.open", "Open ChatGPT"))}</button>`
          : `<button data-managed-browser-action="register">${escapeHtml(this.tr("managed.register", "Register this ChatGPT page as Lead"))}</button>`;
      this.rootElement.innerHTML = `<section class="dashboard-section managed-browser-onboarding">
        <div class="dashboard-section-head"><h3>${escapeHtml(title)}</h3><span>${escapeHtml(availability)}</span></div>
        <p>${lead}</p>
        <p class="dashboard-muted">${escapeHtml(this.tr("managed.loginHint", "Sign in only inside Orchestra\'s isolated browser profile. ChatGPT credentials and cookies are not copied into Orchestra state."))}</p>
        ${this.renderUnsupportedAuth(status)}
        <div class="dashboard-task-controls">
          ${action}
          <button class="secondary" data-managed-browser-action="refresh">${escapeHtml(this.tr("managed.refresh", "Refresh status"))}</button>
        </div>
        ${this.renderValidation()}
      </section>`;
    }

    async handleAction(action) {
      const normalized = String(action || "");
      if (normalized === "refresh") return this.refresh();
      if (normalized === "open-external") return this.transport.openChatGPTExternal?.();
      if (normalized === "use-companion") {
        this.fallbackError = null;
        const prepared = await this.transport.prepareCompanionFallback?.();
        if (!prepared?.ok) {
          this.fallbackError = prepared?.reason || "companion_fallback_prepare_failed";
          this.render();
          return prepared;
        }
        return this.transport.switchRuntime?.("companion");
      }
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
