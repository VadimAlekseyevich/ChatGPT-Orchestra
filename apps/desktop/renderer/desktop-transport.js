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
    restartApplication() {
      if (!this.bridge?.restartApplication) return Promise.resolve({ ok: false, reason: "desktop_restart_unavailable" });
      return this.bridge.restartApplication();
    }
    runtimeMode() {
      if (!this.bridge?.runtimeMode) return Promise.resolve({ ok: false, reason: "desktop_runtime_mode_unavailable" });
      return this.bridge.runtimeMode();
    }
    switchRuntime(mode) {
      if (!this.bridge?.switchRuntime) return Promise.resolve({ ok: false, reason: "desktop_runtime_switch_unavailable" });
      return this.bridge.switchRuntime(String(mode || ""));
    }
    prepareCompanionFallback() {
      if (!this.bridge?.prepareCompanionFallback) return Promise.resolve({ ok: false, reason: "companion_fallback_prepare_unavailable" });
      return this.bridge.prepareCompanionFallback();
    }
    openCompanionExtensionFolder() {
      if (!this.bridge?.openCompanionExtensionFolder) return Promise.resolve({ ok: false, reason: "companion_fallback_extension_open_unavailable" });
      return this.bridge.openCompanionExtensionFolder();
    }
    openChatGPTExternal() {
      if (!this.bridge?.openChatGPTExternal) return Promise.resolve({ ok: false, reason: "external_chatgpt_open_unavailable" });
      return this.bridge.openChatGPTExternal();
    }
  }

  root.DesktopDashboardTransport = DesktopDashboardTransport;
  if (typeof module !== "undefined" && module.exports) module.exports = { DesktopDashboardTransport };
})();
