(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  }

  class DesktopCompanionOnboarding {
    constructor({ rootElement, transport, t = null } = {}) {
      if (!rootElement) throw new TypeError("desktop_companion_onboarding_root_required");
      if (!transport?.runtimeMode) throw new TypeError("desktop_companion_onboarding_transport_invalid");
      this.rootElement = rootElement;
      this.transport = transport;
      this.t = typeof t === "function" ? t : (_key, fallback) => fallback;
      this.mode = null;
      this.packaged = false;
      this.prepared = null;
      this.lastError = null;
      this.busy = false;
      this.onClick = (event) => this.handleClick(event);
    }

    tr(key, fallback, params = {}) {
      const value = this.t(key, fallback, params);
      return String(value ?? "").replace(/\{([A-Za-z0-9_]+)\}/g, (_match, name) =>
        Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : ""
      );
    }

    async start() {
      this.rootElement.addEventListener?.("click", this.onClick);
      await this.refresh();
      return this;
    }

    stop() { this.rootElement.removeEventListener?.("click", this.onClick); }

    async refresh() {
      const response = await this.transport.runtimeMode();
      this.mode = response?.ok ? response.mode : null;
      this.packaged = Boolean(response?.packaged);
      this.render();
      return response;
    }

    render() {
      if (this.mode !== "companion") {
        this.rootElement.innerHTML = "";
        return;
      }
      const prepared = this.prepared;
      this.rootElement.innerHTML = `<section class="dashboard-section desktop-companion-onboarding">
        <div class="dashboard-section-head">
          <h3>${escapeHtml(this.tr("companion.title", "Chrome / Edge extension bridge"))}</h3>
          <span>EXTENSION</span>
        </div>
        <p><strong>${escapeHtml(this.tr("companion.summary", "The native Orchestra app uses the browser extension to control signed-in ChatGPT tabs through Native Messaging."))}</strong></p>
        <ol class="desktop-companion-steps">
          <li>${escapeHtml(this.tr("companion.step1", "Prepare the Orchestra extension and Native Messaging bridge."))}</li>
          <li>${escapeHtml(this.tr("companion.step2", "In Chrome or Edge, enable Developer mode and load the prepared folder as an unpacked extension."))}</li>
          <li>${escapeHtml(this.tr("companion.step3", "Open ChatGPT in that browser and sign in normally, including with Google."))}</li>
          <li>${escapeHtml(this.tr("companion.step4", "Open the Orchestra extension, click “Enable Desktop”, then register the current ChatGPT tab as Lead."))}</li>
        </ol>
        ${this.lastError ? `<div class="dashboard-error">${escapeHtml(this.lastError)}</div>` : ""}
        ${prepared ? `<div class="dashboard-evidence">
          <strong>${escapeHtml(this.tr("companion.ready", "Extension bridge prepared"))}</strong>
          <div><code>${escapeHtml(prepared.extensionDirectory)}</code></div>
          <div>${escapeHtml(this.tr("companion.extensionId", "Extension ID: {id}", { id: prepared.extensionId }))}</div>
        </div>` : ""}
        <div class="dashboard-task-controls">
          <button data-companion-action="prepare" ${this.busy ? "disabled" : ""}>${escapeHtml(this.tr("companion.prepare", "Prepare browser extension bridge"))}</button>
          <button class="secondary" data-companion-action="open-folder" ${!prepared ? "disabled" : ""}>${escapeHtml(this.tr("companion.openFolder", "Open extension folder"))}</button>
          <button class="secondary" data-companion-action="open-chatgpt">${escapeHtml(this.tr("companion.openChatGPT", "Open ChatGPT in browser"))}</button>
          <button class="secondary" data-companion-action="managed">${escapeHtml(this.tr("companion.backManaged", "Use embedded managed browser"))}</button>
        </div>
        ${!this.packaged ? `<p class="dashboard-muted">${escapeHtml(this.tr("companion.packagedHint", "Automatic Native Messaging setup is performed by the packaged native app. Development builds can still prepare the extension manually."))}</p>` : ""}
      </section>`;
    }

    async handleAction(action) {
      const normalized = String(action || "");
      if (normalized === "prepare") {
        this.busy = true;
        this.lastError = null;
        this.render();
        const result = await this.transport.prepareCompanionFallback();
        this.busy = false;
        if (result?.ok) this.prepared = result;
        else this.lastError = result?.reason || "companion_fallback_prepare_failed";
        this.render();
        return result;
      }
      if (normalized === "open-folder") return this.transport.openCompanionExtensionFolder();
      if (normalized === "open-chatgpt") return this.transport.openChatGPTExternal();
      if (normalized === "managed") return this.transport.switchRuntime("managed-browser");
      return null;
    }

    handleClick(event) {
      const button = event.target?.closest?.("[data-companion-action]");
      if (!button || button.disabled) return;
      return this.handleAction(button.dataset.companionAction);
    }
  }

  root.DesktopCompanionOnboarding = DesktopCompanionOnboarding;
  if (typeof module !== "undefined" && module.exports) module.exports = { DesktopCompanionOnboarding };
})();