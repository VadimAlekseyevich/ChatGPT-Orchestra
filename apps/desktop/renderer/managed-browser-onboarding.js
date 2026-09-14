(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  }

  class ManagedBrowserOnboarding {
    constructor({ rootElement, transport, pollMs = 2500 } = {}) {
      if (!rootElement) throw new TypeError("managed_browser_onboarding_root_required");
      if (!transport?.query || !transport?.execute) throw new TypeError("managed_browser_onboarding_transport_invalid");
      this.rootElement = rootElement;
      this.transport = transport;
      this.pollMs = Math.max(1000, Number(pollMs) || 2500);
      this.status = null;
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
            return;
          }
          throw new Error(response?.reason || "managed_browser_status_failed");
        }
        this.status = response.managedBrowser || null;
      } catch (_) {
        this.status = null;
      } finally {
        this.refreshing = false;
        this.render();
      }
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
      return null;
    }

    handleClick(event) {
      const button = event.target?.closest?.("[data-managed-browser-action]");
      if (!button || button.disabled) return;
      return this.handleAction(button.dataset.managedBrowserAction);
    }
  }

  root.ManagedBrowserOnboarding = ManagedBrowserOnboarding;
  if (typeof module !== "undefined" && module.exports) module.exports = { ManagedBrowserOnboarding };
})();
