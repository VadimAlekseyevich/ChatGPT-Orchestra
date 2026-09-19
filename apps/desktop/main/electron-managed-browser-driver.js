"use strict";

const path = require("node:path");

const DEFAULT_CHATGPT_URL = "https://chatgpt.com/";
const DEFAULT_AGENT_PRELOAD = path.join(__dirname, "..", "agent-preload.js");

// Top-level navigation remains fail-closed. The first-party suffixes cover
// OpenAI's current auth hosts such as setup.auth.openai.com and auth0.openai.com,
// while the exact third-party origins are limited to login/challenge providers
// that can be part of the interactive ChatGPT sign-in flow.
const ALLOWED_ORIGINS = Object.freeze(new Set([
  "https://chatgpt.com",
  "https://openai.com",
  "https://accounts.google.com",
  "https://appleid.apple.com",
  "https://login.microsoftonline.com",
  "https://login.live.com",
  "https://setup.workos.com",
  "https://forwarder.workos.com",
  "https://challenges.cloudflare.com"
]));
const ALLOWED_HOST_SUFFIXES = Object.freeze([
  ".chatgpt.com",
  ".openai.com"
]);

function asError(error) { return String(error?.message || error || "unknown_error"); }

function isAllowedManagedNavigation(parsed) {
  if (ALLOWED_ORIGINS.has(parsed.origin)) return true;
  const hostname = String(parsed.hostname || "").toLowerCase();
  return ALLOWED_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix));
}

function unsupportedEmbeddedAuthProvider(value) {
  let parsed;
  try { parsed = new URL(String(value || "")); } catch (_) { return null; }
  return parsed.origin === "https://accounts.google.com" ? "google" : null;
}

function assertManagedNavigationUrl(value) {
  const raw = String(value || "").trim();
  if (raw === "about:blank") return raw;
  let parsed;
  try { parsed = new URL(raw); } catch (_) { throw new Error("managed_browser_navigation_url_invalid"); }
  if (parsed.protocol !== "https:" || !isAllowedManagedNavigation(parsed)) throw new Error("managed_browser_navigation_forbidden");
  return parsed.toString();
}

class ElectronManagedBrowserDriver {
  constructor({
    electronApi = null,
    pageAdapter = null,
    logger = console,
    windowOptions = null,
    preloadPath = DEFAULT_AGENT_PRELOAD
  } = {}) {
    this.electronApi = electronApi;
    this.pageAdapter = pageAdapter;
    this.logger = logger;
    this.windowOptions = windowOptions || {};
    this.preloadPath = path.resolve(String(preloadPath || DEFAULT_AGENT_PRELOAD));
    this.browserSession = null;
    this.profileDirectory = null;
    this.sessions = new Map();
    this.listeners = new Set();
    this.nextSession = 1;
    this.started = false;
    this.closing = false;
  }

  resolveElectron() {
    if (this.electronApi) return this.electronApi;
    // Loaded lazily so Node-only contract tests do not require Electron.
    // eslint-disable-next-line global-require
    this.electronApi = require("electron");
    return this.electronApi;
  }

  async start({ profileDirectory } = {}) {
    if (this.started) return { ok: true, reused: true };
    const normalized = path.resolve(String(profileDirectory || ""));
    if (!profileDirectory || !path.isAbsolute(normalized)) throw new TypeError("managed_browser_profile_directory_absolute_required");
    const electron = this.resolveElectron();
    if (typeof electron?.session?.fromPath !== "function" || typeof electron?.BrowserWindow !== "function") {
      throw new TypeError("electron_managed_browser_api_unavailable");
    }
    this.profileDirectory = normalized;
    this.browserSession = electron.session.fromPath(normalized, { cache: true });
    this.pageAdapter?.start?.();
    this.started = true;
    this.closing = false;
    return { ok: true };
  }

  subscribe(listener) {
    if (typeof listener !== "function") throw new TypeError("managed_browser_listener_required");
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event) {
    for (const listener of [...this.listeners]) {
      try { listener(event); } catch (error) { this.logger?.warn?.("managed_browser_listener_failed", { error: asError(error) }); }
    }
  }

  ensureStarted() {
    if (!this.started || !this.browserSession) throw new Error("managed_browser_driver_not_started");
  }

  entry(sessionId) {
    return this.sessions.get(String(sessionId ?? "")) || null;
  }

  sessionDto(sessionId, entry = this.entry(sessionId)) {
    if (!entry?.window || entry.window.isDestroyed?.()) return null;
    const webContents = entry.window.webContents;
    return {
      id: String(sessionId),
      url: String(webContents?.getURL?.() || entry.url || ""),
      active: Boolean(entry.window.isFocused?.()),
      title: String(webContents?.getTitle?.() || entry.window.getTitle?.() || "")
    };
  }

  attachWindow(sessionId, window) {
    const id = String(sessionId);
    const redirectUnsupportedAuth = (rawUrl) => {
      const provider = unsupportedEmbeddedAuthProvider(rawUrl);
      if (!provider) return false;
      const entry = this.entry(id);
      if (entry) entry.unsupportedAuthProvider = provider;
      window.hide?.();
      Promise.resolve(this.resolveElectron()?.shell?.openExternal?.(DEFAULT_CHATGPT_URL)).catch((error) => {
        this.emit({ type: "navigation-blocked", sessionId: id, reason: `external_auth_open_failed:${asError(error)}` });
      });
      this.emit({ type: "unsupported-auth-provider", sessionId: id, provider });
      return true;
    };
    const onNavigation = (_event, url) => {
      const entry = this.entry(id);
      if (entry) {
        entry.url = String(url || "");
        if (!unsupportedEmbeddedAuthProvider(url)) entry.unsupportedAuthProvider = null;
      }
      this.emit({ type: "session-navigation", sessionId: id, url: String(url || "") });
    };
    window.webContents?.on?.("will-navigate", (event, url) => {
      if (redirectUnsupportedAuth(url)) {
        event?.preventDefault?.();
        return;
      }
      try { assertManagedNavigationUrl(url); } catch (error) {
        event?.preventDefault?.();
        this.emit({ type: "navigation-blocked", sessionId: id, url: String(url || ""), reason: asError(error) });
      }
    });
    window.webContents?.on?.("did-navigate", onNavigation);
    window.webContents?.on?.("did-navigate-in-page", onNavigation);
    window.webContents?.on?.("render-process-gone", (_event, details = {}) => {
      if (!this.sessions.has(id)) return;
      this.sessions.delete(id);
      this.emit({ type: "session-removed", sessionId: id, reason: `render_process_gone:${String(details.reason || "unknown")}` });
    });
    window.on?.("closed", () => {
      if (!this.sessions.has(id)) return;
      this.sessions.delete(id);
      if (!this.closing) this.emit({ type: "session-removed", sessionId: id, reason: "window_closed" });
    });

    // Auth flows may use window.open(). Do not create an unmanaged child window.
    // Instead, redirect an allowlisted login URL through the same isolated
    // BrowserWindow/session. Unknown destinations remain denied.
    window.webContents?.setWindowOpenHandler?.((details = {}) => {
      const rawUrl = String(details.url || "");
      if (redirectUnsupportedAuth(rawUrl)) return { action: "deny" };
      let targetUrl;
      try {
        targetUrl = assertManagedNavigationUrl(rawUrl);
      } catch (error) {
        this.emit({ type: "navigation-blocked", sessionId: id, url: rawUrl, reason: asError(error) });
        return { action: "deny" };
      }
      Promise.resolve().then(async () => {
        if (!this.sessions.has(id) || window.isDestroyed?.()) return;
        try {
          await window.loadURL(targetUrl);
          const entry = this.entry(id);
          if (entry) entry.url = targetUrl;
          this.emit({ type: "auth-navigation-redirected", sessionId: id, url: targetUrl });
        } catch (error) {
          this.emit({ type: "navigation-blocked", sessionId: id, url: targetUrl, reason: `auth_redirect_failed:${asError(error)}` });
        }
      });
      return { action: "deny" };
    });
  }

  async createSession({ url = DEFAULT_CHATGPT_URL, active = false } = {}) {
    this.ensureStarted();
    const targetUrl = assertManagedNavigationUrl(url || DEFAULT_CHATGPT_URL);
    const electron = this.resolveElectron();
    const id = `electron-page-${this.nextSession++}`;
    const window = new electron.BrowserWindow({
      width: 1120,
      height: 900,
      show: Boolean(active),
      title: "ChatGPT Orchestra · Agent",
      ...this.windowOptions,
      webPreferences: {
        ...(this.windowOptions.webPreferences || {}),
        session: this.browserSession,
        preload: this.preloadPath,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        devTools: false
      }
    });
    this.sessions.set(id, { window, url: targetUrl, unsupportedAuthProvider: null });
    this.attachWindow(id, window);
    try {
      await window.loadURL(targetUrl);
      if (active) {
        window.show?.();
        window.focus?.();
      }
      return this.sessionDto(id);
    } catch (error) {
      this.sessions.delete(id);
      try { window.destroy?.(); } catch (_) {}
      throw error;
    }
  }

  async getActiveSession() {
    this.ensureStarted();
    for (const [id, entry] of this.sessions) if (entry.window?.isFocused?.()) return this.sessionDto(id, entry);
    for (const [id, entry] of this.sessions) if (entry.window?.isVisible?.()) return this.sessionDto(id, entry);
    return null;
  }

  async getSession(sessionId) {
    this.ensureStarted();
    return this.sessionDto(String(sessionId ?? ""));
  }

  async navigateSession(sessionId, url) {
    this.ensureStarted();
    const id = String(sessionId ?? "");
    const entry = this.entry(id);
    if (!entry?.window || entry.window.isDestroyed?.()) throw new Error("managed_browser_session_missing");
    const targetUrl = assertManagedNavigationUrl(url);
    await entry.window.loadURL(targetUrl);
    entry.url = targetUrl;
    return this.sessionDto(id, entry);
  }

  async removeSession(sessionId) {
    this.ensureStarted();
    const id = String(sessionId ?? "");
    const entry = this.entry(id);
    if (!entry) return false;
    this.sessions.delete(id);
    try { entry.window.close?.(); } catch (_) { try { entry.window.destroy?.(); } catch (_) {} }
    return true;
  }

  async activateSession(sessionId) {
    this.ensureStarted();
    const id = String(sessionId ?? "");
    const entry = this.entry(id);
    if (!entry?.window || entry.window.isDestroyed?.()) throw new Error("managed_browser_session_missing");
    entry.unsupportedAuthProvider = null;
    entry.window.show?.();
    entry.window.restore?.();
    entry.window.focus?.();
    return this.sessionDto(id, entry);
  }

  async pingSession(sessionId) {
    this.ensureStarted();
    const id = String(sessionId ?? "");
    const entry = this.entry(id);
    if (!entry?.window || entry.window.isDestroyed?.()) return { ok: false, reason: "session_unavailable" };
    if (typeof this.pageAdapter?.ping === "function") {
      const result = await this.pageAdapter.ping(entry.window.webContents);
      return { ...result, unsupportedAuthProvider: entry.unsupportedAuthProvider || null };
    }
    return { ok: true, availability: "unavailable", url: String(entry.window.webContents?.getURL?.() || entry.url || ""), unsupportedAuthProvider: entry.unsupportedAuthProvider || null };
  }

  async readAssistantSnapshot(sessionId) {
    this.ensureStarted();
    const entry = this.entry(sessionId);
    if (!entry?.window || entry.window.isDestroyed?.()) return { ok: false, reason: "session_unavailable" };
    if (typeof this.pageAdapter?.readAssistantSnapshot !== "function") return { ok: false, reason: "chatgpt_page_adapter_unavailable" };
    return this.pageAdapter.readAssistantSnapshot(entry.window.webContents);
  }

  async sendPrompt(sessionId, prompt) {
    this.ensureStarted();
    const entry = this.entry(sessionId);
    if (!entry?.window || entry.window.isDestroyed?.()) return { ok: false, reason: "session_unavailable" };
    if (typeof this.pageAdapter?.sendPrompt !== "function") return { ok: false, reason: "chatgpt_page_adapter_unavailable" };
    return this.pageAdapter.sendPrompt(entry.window.webContents, String(prompt || ""));
  }

  async stopGeneration(sessionId) {
    this.ensureStarted();
    const entry = this.entry(sessionId);
    if (!entry?.window || entry.window.isDestroyed?.()) return { ok: false, reason: "session_unavailable" };
    if (typeof this.pageAdapter?.stopGeneration !== "function") return { ok: false, reason: "chatgpt_page_adapter_unavailable" };
    return this.pageAdapter.stopGeneration(entry.window.webContents);
  }

  async close() {
    if (!this.started) return;
    this.closing = true;
    for (const [id, entry] of [...this.sessions]) {
      this.sessions.delete(id);
      try { entry.window.close?.(); } catch (_) { try { entry.window.destroy?.(); } catch (_) {} }
    }
    this.listeners.clear();
    try { this.pageAdapter?.close?.(); } catch (_) {}
    this.browserSession = null;
    this.profileDirectory = null;
    this.started = false;
    this.closing = false;
  }
}

module.exports = {
  ElectronManagedBrowserDriver,
  DEFAULT_CHATGPT_URL,
  DEFAULT_AGENT_PRELOAD,
  ALLOWED_ORIGINS,
  ALLOWED_HOST_SUFFIXES,
  unsupportedEmbeddedAuthProvider,
  assertManagedNavigationUrl
};
