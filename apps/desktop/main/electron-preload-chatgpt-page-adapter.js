"use strict";

const fs = require("node:fs");
const path = require("node:path");
const SELECTORS = require("../../../content/selectors.js");
const Utils = require("../../../content/utils.js");
const { normalizeTraceContext, traceDetails, byteLength } = require("./runtime-trace.js");

const COMMAND_CHANNEL = "orchestra:agent:command";
const RESPONSE_CHANNEL = "orchestra:agent:response";
const DEFAULT_MAX_ASSISTANT_BYTES = 384 * 1024;
const ASSISTANT_TRACKER_WORLD_ID = 1001;
const DEFAULT_TURN_TRACKER_PATH = path.join(__dirname, "..", "..", "..", "content", "assistant-turn-tracker.js");

function currentUrl(webContents) {
  try { return String(webContents?.getURL?.() || ""); } catch (_) { return ""; }
}

class ElectronPreloadChatGPTPageAdapter {
  constructor({
    ipcMain = null,
    selectors = SELECTORS,
    requestTimeoutMs = 7000,
    maxAssistantBytes = DEFAULT_MAX_ASSISTANT_BYTES,
    turnTrackerPath = DEFAULT_TURN_TRACKER_PATH,
    turnTrackerSource = null,
    logger = console
  } = {}) {
    this.ipcMain = ipcMain;
    this.selectors = selectors;
    this.requestTimeoutMs = Math.max(500, Math.min(30000, Number(requestTimeoutMs) || 7000));
    this.maxAssistantBytes = Math.max(4096, Number(maxAssistantBytes) || DEFAULT_MAX_ASSISTANT_BYTES);
    this.turnTrackerPath = path.resolve(String(turnTrackerPath || DEFAULT_TURN_TRACKER_PATH));
    this.turnTrackerSource = turnTrackerSource === null
      ? fs.readFileSync(this.turnTrackerPath, "utf8")
      : String(turnTrackerSource || "");
    this.logger = logger;
    this.pending = new Map();
    this.nextRequest = 1;
    this.started = false;
    this.responseListener = (event, message) => this.handleResponse(event, message);
  }

  resolveIpcMain() {
    if (this.ipcMain) return this.ipcMain;
    // Loaded lazily so Node-only tests can inject a fake IPC boundary.
    // eslint-disable-next-line global-require
    this.ipcMain = require("electron").ipcMain;
    return this.ipcMain;
  }

  start() {
    if (this.started) return this;
    const ipcMain = this.resolveIpcMain();
    if (typeof ipcMain?.on !== "function" || typeof ipcMain?.removeListener !== "function") throw new TypeError("electron_ipc_main_unavailable");
    ipcMain.on(RESPONSE_CHANNEL, this.responseListener);
    this.started = true;
    return this;
  }

  handleResponse(event, message = {}) {
    const requestId = String(message?.requestId || "");
    const pending = this.pending.get(requestId);
    if (!pending) return;
    const senderId = event?.sender?.id;
    if (String(senderId ?? "") !== pending.senderId) {
      this.logger?.warn?.("agent_preload_response_sender_mismatch", { requestId });
      return;
    }
    this.pending.delete(requestId);
    clearTimeout(pending.timer);
    pending.resolve(message?.result && typeof message.result === "object"
      ? message.result
      : { ok: false, reason: "agent_preload_invalid_response" });
  }

  request(webContents, name, payload = {}, options = {}) {
    this.start();
    if (typeof webContents?.send !== "function") return Promise.resolve({ ok: false, reason: "agent_web_contents_unavailable" });
    const senderId = String(webContents.id ?? "");
    if (!senderId) return Promise.resolve({ ok: false, reason: "agent_web_contents_id_missing" });
    const requestId = `agent-page-${this.nextRequest++}`;
    const requestedTimeout = Number(options.timeoutMs);
    const timeoutMs = Number.isFinite(requestedTimeout)
      ? Math.max(250, Math.min(30000, requestedTimeout))
      : this.requestTimeoutMs;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve({ ok: false, reason: "agent_preload_timeout" });
      }, timeoutMs);
      this.pending.set(requestId, { resolve, timer, senderId });
      try {
        webContents.send(COMMAND_CHANNEL, {
          requestId,
          name: String(name || ""),
          payload: payload && typeof payload === "object" ? payload : {},
          selectors: this.selectors
        });
      } catch (error) {
        this.pending.delete(requestId);
        clearTimeout(timer);
        resolve({ ok: false, reason: "agent_preload_send_failed", message: String(error?.message || error) });
      }
    });
  }

  async readPageStatusDirect(webContents) {
    const url = currentUrl(webContents);
    let origin;
    try { origin = new URL(url).origin; } catch (_) { return { ok: false, reason: "page_url_invalid" }; }
    if (origin !== "https://chatgpt.com") {
      return { ok: false, reason: "page_origin_not_chatgpt" };
    }
    if (typeof webContents?.executeJavaScriptInIsolatedWorld !== "function") {
      return { ok: false, reason: "direct_page_status_unavailable" };
    }
    // Only inspect public composer state. Never read prompts, cookies or account data.
    const source = `(() => {
      if (location.origin !== "https://chatgpt.com") {
        return { ok: false, reason: "page_origin_not_chatgpt" };
      }
      const candidates = [
        "#prompt-textarea",
        'textarea[name="prompt-textarea"]',
        'textarea#prompt-textarea',
        'form [contenteditable="true"][role="textbox"]',
        '[data-testid="composer-input"][contenteditable="true"]',
        'div[contenteditable="true"][data-lexical-editor="true"]'
      ];
      let composer = null;
      for (const selector of candidates) {
        const matches = document.querySelectorAll(selector);
        composer = Array.from(matches).find((element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width > 0 && rect.height > 0 &&
            style.display !== "none" && style.visibility !== "hidden";
        });
        if (composer) break;
      }
      const generating = Boolean(document.querySelector(
        'button[data-testid="stop-button"], [role="button"][data-testid="stop-button"]'
      ));
      const occupied = composer
        ? Boolean(String(composer.value ?? composer.innerText ?? composer.textContent ?? "").trim())
        : null;
      return {
        ok: true,
        availability: generating ? "generating" : composer ? "ready" : "unavailable",
        generating,
        composerOccupied: occupied,
        pathname: String(location.pathname || ""),
        url: String(location.href || "")
      };
    })()`;
    try {
      const result = await webContents.executeJavaScriptInIsolatedWorld(1002, [{ code: source }]);
      return result && typeof result === "object"
        ? result
        : { ok: false, reason: "direct_page_status_invalid" };
    } catch (error) {
      return { ok: false, reason: "direct_page_status_failed", message: String(error?.message || error) };
    }
  }

  async ping(webContents) {
    const preload = await this.request(webContents, "status", {}, {
      timeoutMs: Math.min(this.requestTimeoutMs, 1500)
    });
    if (preload?.ok && ["ready", "generating"].includes(String(preload.availability || ""))) {
      return preload;
    }
    const direct = await this.readPageStatusDirect(webContents);
    if (direct?.ok && ["ready", "generating"].includes(String(direct.availability || ""))) {
      this.logger?.warn?.("managed_browser_status_direct_recovery", {
        preloadReason: String(preload?.reason || "none"),
        preloadAvailability: String(preload?.availability || "unavailable"),
        directAvailability: direct.availability
      });
      return direct;
    }
    // A page with no working composer must never be advertised as ready.
    return preload?.ok ? preload : direct?.ok ? direct : preload;
  }

  navigationSignal(webContents, initialUrl) {
    if (typeof webContents?.on !== "function" || typeof webContents?.removeListener !== "function") {
      return { promise: new Promise(() => {}), close() {} };
    }
    let closed = false;
    let resolveSignal;
    const promise = new Promise((resolve) => { resolveSignal = resolve; });
    const onNavigation = (_event, url) => {
      if (closed) return;
      const nextUrl = String(url || currentUrl(webContents) || "");
      if (!nextUrl || !initialUrl || nextUrl === initialUrl) return;
      closed = true;
      cleanup();
      resolveSignal({ ok: true, accepted: true, confirmed: true, method: "navigation", url: nextUrl });
    };
    const cleanup = () => {
      try { webContents.removeListener("did-navigate", onNavigation); } catch (_) {}
      try { webContents.removeListener("did-navigate-in-page", onNavigation); } catch (_) {}
    };
    webContents.on("did-navigate", onNavigation);
    webContents.on("did-navigate-in-page", onNavigation);
    return {
      promise,
      close() {
        if (closed) return;
        closed = true;
        cleanup();
      }
    };
  }

  async waitForNativeSubmission(webContents, timeoutMs = 1800, initialUrl = "") {
    const startedAt = Date.now();
    let latest = null;
    while (Date.now() - startedAt < timeoutMs) {
      latest = await this.request(webContents, "status", {}, { timeoutMs: Math.min(1000, timeoutMs) });
      if (!latest?.ok) return latest;
      const latestUrl = String(latest.url || currentUrl(webContents) || "");
      const navigated = Boolean(initialUrl && latestUrl && latestUrl !== initialUrl);
      const generating = latest.generating === true || latest.availability === "generating";
      const readyAndCleared = latest.availability === "ready" && latest.composerOccupied === false;
      if (navigated || generating || readyAndCleared) {
        return {
          ...latest,
          ok: true,
          accepted: true,
          confirmed: true,
          method: navigated ? "navigation-reconciled" : "trusted-enter"
        };
      }
      await Utils.sleep(100);
    }
    return {
      ok: false,
      reason: "send_not_confirmed",
      promptStaged: latest?.composerOccupied === true,
      fallback: "trusted-enter"
    };
  }

  async recoverTimedOutSubmission(webContents, initialUrl, originalResult, navigationPromise = null) {
    const recoveredFrom = originalResult?.reason || "agent_preload_timeout";
    const recoveryMs = Math.max(2500, Math.min(10000, this.requestTimeoutMs + 3000));
    const deadline = Date.now() + recoveryMs;
    let trustedEnterSent = false;

    while (Date.now() < deadline) {
      const directUrl = currentUrl(webContents);
      if (initialUrl && directUrl && directUrl !== initialUrl) {
        return {
          ok: true,
          accepted: true,
          confirmed: true,
          method: "navigation-reconciled",
          url: directUrl,
          recoveredFrom
        };
      }

      const remainingMs = Math.max(250, deadline - Date.now());
      const statusPromise = this.request(webContents, "status", {}, {
        timeoutMs: Math.min(1200, remainingMs)
      });
      const latest = navigationPromise
        ? await Promise.race([statusPromise, navigationPromise])
        : await statusPromise;

      if (latest?.ok && latest.accepted === true && latest.confirmed === true && latest.method === "navigation") {
        return { ...latest, recoveredFrom };
      }

      if (latest?.ok) {
        const latestUrl = String(latest.url || currentUrl(webContents) || "");
        const navigated = Boolean(initialUrl && latestUrl && latestUrl !== initialUrl);
        const generating = latest.generating === true || latest.availability === "generating";
        if (navigated || generating) {
          return {
            ...latest,
            ok: true,
            accepted: true,
            confirmed: true,
            method: navigated ? "navigation-reconciled" : "status-reconciled",
            recoveredFrom
          };
        }
        if (latest.composerOccupied === true && !trustedEnterSent && typeof webContents?.sendInputEvent === "function") {
          trustedEnterSent = true;
          try {
            webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
            webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
          } catch (error) {
            return {
              ...originalResult,
              ok: false,
              message: String(error?.message || error)
            };
          }
          const confirmed = await Promise.race([
            this.waitForNativeSubmission(webContents, Math.min(1800, Math.max(250, deadline - Date.now())), initialUrl),
            ...(navigationPromise ? [navigationPromise] : [])
          ]);
          if (confirmed?.ok) {
            return {
              ...confirmed,
              recoveredFrom
            };
          }
        }
      }

      if (Date.now() < deadline) await Utils.sleep(150);
    }

    return originalResult;
  }

  async sendPrompt(webContents, prompt, options = {}) {
    const trace = normalizeTraceContext(options?.trace);
    const promptBytes = byteLength(prompt);
    const startedAt = Date.now();
    this.logger?.info?.("managed_browser_preload_prompt_send_started", traceDetails(trace, { promptBytes }));
    try {
      const result = await this.sendPromptInternal(webContents, prompt);
      const details = traceDetails(trace, {
        promptBytes,
        ok: result?.ok !== false,
        accepted: result?.accepted === true || result?.ok === true,
        confirmed: result?.confirmed === true,
        method: result?.method || null,
        recoveredFrom: result?.recoveredFrom || null,
        reason: result?.reason || null,
        durationMs: Math.max(0, Date.now() - startedAt)
      });
      if (result?.ok === false) this.logger?.warn?.("managed_browser_preload_prompt_send_failed", details);
      else this.logger?.info?.("managed_browser_preload_prompt_send_completed", details);
      return result;
    } catch (error) {
      this.logger?.error?.("managed_browser_preload_prompt_send_failed", traceDetails(trace, {
        promptBytes,
        reason: "preload_prompt_send_error",
        durationMs: Math.max(0, Date.now() - startedAt),
        error
      }));
      throw error;
    }
  }

  async sendPromptInternal(webContents, prompt) {
    const initialUrl = currentUrl(webContents);
    const navigation = this.navigationSignal(webContents, initialUrl);
    let result;
    try {
      const confirmationMs = 900;
      const commandTimeoutMs = Math.max(250, Math.min(15000, this.requestTimeoutMs - confirmationMs - 500));
      const outerTimeoutMs = Math.min(30000, Math.max(this.requestTimeoutMs, commandTimeoutMs + confirmationMs + 1000));
      result = await Promise.race([
        this.request(webContents, "send-prompt", {
          prompt: String(prompt || ""),
          timeoutMs: commandTimeoutMs,
          confirmationMs
        }, { timeoutMs: outerTimeoutMs }),
        navigation.promise
      ]);

      if (result?.ok) return result;
      if (result?.reason === "agent_preload_timeout") {
        const recovered = await this.recoverTimedOutSubmission(webContents, initialUrl, result, navigation.promise);
        if (recovered?.ok) return recovered;
        result = recovered || result;
      }
      if (result?.reason !== "send_not_confirmed" || result?.promptStaged !== true) return result;
      if (typeof webContents?.sendInputEvent !== "function") return result;

      try {
        // A BrowserWindow-level keyboard event is trusted by Chromium, unlike a
        // synthetic DOM click/KeyboardEvent created inside the remote page.
        webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
        webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
      } catch (error) {
        return {
          ...result,
          ok: false,
          reason: "send_not_confirmed",
          fallback: "trusted-enter",
          message: String(error?.message || error)
        };
      }

      return await Promise.race([
        this.waitForNativeSubmission(webContents, 1800, initialUrl),
        navigation.promise
      ]);
    } finally {
      navigation.close();
    }
  }

  async stopGeneration(webContents) {
    return this.request(webContents, "stop-generation");
  }

  async observeAssistantSnapshot(webContents) {
    if (typeof webContents?.executeJavaScriptInIsolatedWorld !== "function") {
      return this.request(webContents, "read-assistant");
    }
    const selectors = JSON.stringify(this.selectors || {});
    const bootstrap = `if (!globalThis.ChatGPTOrchestra?.AssistantTurnTracker) {\n${this.turnTrackerSource}\n}`;
    const observe = `(() => {
      const Tracker = globalThis.ChatGPTOrchestra?.AssistantTurnTracker;
      if (typeof Tracker !== "function") return { ok: false, reason: "assistant_turn_tracker_unavailable" };
      const selectors = ${selectors};
      let tracker = globalThis.__orchestraAssistantTurnTracker;
      if (!tracker) {
        tracker = new Tracker({ documentRef: document, locationRef: location, selectors });
        globalThis.__orchestraAssistantTurnTracker = tracker;
      } else {
        tracker.setSelectors(selectors);
      }
      const snapshot = tracker.getSnapshot();
      return {
        ok: snapshot?.ok !== false,
        reason: snapshot?.ok === false ? String(snapshot.reason || "assistant_turn_snapshot_failed") : null,
        conversationKey: String(snapshot?.conversationKey || location.pathname || ""),
        pathname: String(snapshot?.conversationKey || location.pathname || ""),
        messageCount: Math.max(0, Number(snapshot?.mountedTurnCount) || 0),
        observedTurnCount: Math.max(0, Number(snapshot?.assistantTurnCountObserved) || 0),
        turnId: String(snapshot?.latestTurnId || ""),
        latestTurnId: String(snapshot?.latestTurnId || ""),
        identitySource: String(snapshot?.latestIdentitySource || ""),
        text: String(snapshot?.latestText || ""),
        turnChanged: Boolean(snapshot?.turnChanged),
        textChanged: Boolean(snapshot?.textChanged),
        conversationChanged: Boolean(snapshot?.conversationChanged),
        hydrationCandidate: Boolean(snapshot?.hydrationCandidate),
        assistantTurnStatus: snapshot?.ok === false ? "ambiguous" : "ok"
      };
    })()`;
    try {
      return await webContents.executeJavaScriptInIsolatedWorld(
        ASSISTANT_TRACKER_WORLD_ID,
        [{ code: bootstrap }, { code: observe }]
      );
    } catch (error) {
      return {
        ok: false,
        reason: "assistant_turn_tracker_execution_failed",
        message: String(error?.message || error)
      };
    }
  }

  async readAssistantSnapshot(webContents) {
    const [status, observed] = await Promise.all([
      this.request(webContents, "status"),
      this.observeAssistantSnapshot(webContents)
    ]);
    if (!status?.ok) return status || { ok: false, reason: "assistant_status_failed" };
    if (!observed?.ok) return observed || { ok: false, reason: "assistant_snapshot_failed" };
    const result = { ...status, ...observed, url: String(status.url || currentUrl(webContents) || "") };
    if (!result?.ok) return result || { ok: false, reason: "assistant_snapshot_failed" };
    const text = Utils.normalizeText(result.text || "");
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > this.maxAssistantBytes) return { ok: false, reason: "assistant_response_too_large", bytes, maxBytes: this.maxAssistantBytes };

    const conversationKey = String(result.conversationKey || result.pathname || "");
    const pathname = String(result.pathname || conversationKey);
    const messageCount = Math.max(0, Number(result.messageCount) || 0);
    const observedTurnCount = Math.max(0, Number(result.observedTurnCount) || 0);
    const turnId = String(result.turnId || result.latestTurnId || "");
    const textFingerprint = text ? Utils.hashString(text) : "";
    const fingerprint = text
      ? Utils.hashString(turnId
        ? `${conversationKey}:${turnId}:${text}`
        : `${conversationKey}:${messageCount}:${text}`)
      : "";

    if (text && !turnId && String(result.assistantTurnStatus || "") === "ok") {
      return {
        ok: false,
        reason: "assistant_turn_identity_missing",
        conversationKey,
        pathname,
        messageCount,
        observedTurnCount
      };
    }

    return {
      ok: true,
      text,
      bytes,
      messageCount,
      observedTurnCount,
      conversationKey,
      pathname,
      url: String(result.url || ""),
      availability: String(result.availability || "unavailable"),
      generating: Boolean(result.generating),
      turnId,
      latestTurnId: turnId,
      identitySource: String(result.identitySource || ""),
      textFingerprint,
      latestTextFingerprint: textFingerprint,
      turnChanged: Boolean(result.turnChanged),
      textChanged: Boolean(result.textChanged),
      conversationChanged: Boolean(result.conversationChanged),
      hydrationCandidate: Boolean(result.hydrationCandidate),
      fingerprint
    };
  }

  close() {
    if (this.started) this.resolveIpcMain().removeListener(RESPONSE_CHANNEL, this.responseListener);
    this.started = false;
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, reason: "agent_preload_adapter_closed" });
      this.pending.delete(requestId);
    }
  }
}

module.exports = {
  ElectronPreloadChatGPTPageAdapter,
  COMMAND_CHANNEL,
  RESPONSE_CHANNEL,
  DEFAULT_MAX_ASSISTANT_BYTES,
  ASSISTANT_TRACKER_WORLD_ID,
  DEFAULT_TURN_TRACKER_PATH
};
