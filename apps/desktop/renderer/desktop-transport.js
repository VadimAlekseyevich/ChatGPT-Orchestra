(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};

  class DesktopDashboardTransport {
    constructor({ bridge = globalThis.orchestraDesktop } = {}) {
      this.bridge = bridge;
    }
    query(name, payload = {}) {
      if (!this.bridge?.query) return Promise.resolve({ apiVersion: 4, ok: false, reason: "desktop_bridge_unavailable" });
      return this.bridge.query(String(name || ""), payload);
    }
    execute(name, payload = {}) {
      if (!this.bridge?.execute) return Promise.resolve({ apiVersion: 4, ok: false, reason: "desktop_bridge_unavailable" });
      return this.bridge.execute(String(name || ""), payload);
    }
    selectRepositoryDirectory() {
      if (!this.bridge?.selectRepositoryDirectory) return Promise.resolve({ ok: false, reason: "desktop_directory_picker_unavailable" });
      return this.bridge.selectRepositoryDirectory();
    }
  }

  root.DesktopDashboardTransport = DesktopDashboardTransport;
  if (typeof module !== "undefined" && module.exports) module.exports = { DesktopDashboardTransport };
})();
