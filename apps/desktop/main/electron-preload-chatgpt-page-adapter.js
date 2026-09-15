"use strict";

const SELECTORS = require("../../../content/selectors.js");
const Utils = require("../../../content/utils.js");

const COMMAND_CHANNEL = "orchestra:agent:command";
const RESPONSE_CHANNEL = "orchestra:agent:response";
const DEFAULT_MAX_ASSISTANT_BYTES = 384 * 1024;

class ElectronPreloadChatGPTPageAdapter {
  constructor({
    ipcMain = null,
    selectors = SELECTORS,
    requestTimeoutMs = 7000,
    maxAssistantBytes = DEFAULT_MAX_ASSISTANT_BYTES,
    logger = console
  } = {}) {
    this.ipcMain = ipcMain;
    this.selectors = selectors;
    this.requestTimeoutMs = Math.max(500, Math.min(30000, Number(requestTimeoutMs) || 7000));
    this.maxAssistantBytes = Math.max(4096, Number(maxAssistantBytes) || DEFAULT_MAX_ASSISTANT_BYTES);
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

  request(webContents, name, payload = {}) {
    this.start();
    if (typeof webContents?.send !== "function") return Promise.resolve({ ok: false, reason: "agent_web_contents_unavailable" });
    const senderId = String(webContents.id ?? "");
    if (!senderId) return Promise.resolve({ ok: false, reason: "agent_web_contents_id_missing" });
    const requestId = `agent-page-${this.nextRequest++}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve({ ok: false, reason: "agent_preload_timeout" });
      }, this.requestTimeoutMs);
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

  async ping(webContents) {
    return this.request(webContents, "status");
  }

  async waitForNativeSubmission(webContents, timeoutMs = 1800) {
    const startedAt = Date.now();
    let latest = null;
    while (Date.now() - startedAt < timeoutMs) {
      latest = await this.request(webContents, "status");
      if (!latest?.ok) return latest;
      if (latest.generating === true || latest.availability === "generating" || latest.composerOccupied === false) {
        return { ...latest, ok: true, accepted: true, confirmed: true, method: "trusted-enter" };
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

  async sendPrompt(webContents, prompt) {
    const result = await this.request(webContents, "send-prompt", {
      prompt: String(prompt || ""),
      timeoutMs: Math.min(this.requestTimeoutMs - 250, 15000),
      confirmationMs: 900
    });
    if (result?.ok) return result;
    if (result?.reason !== "send_not_confirmed" || result?.promptStaged !== true) return result;
    if (typeof webContents?.sendInputEvent !== "function") return result;

    try {
      // A BrowserWindow-level keyboard event is trusted by Chromium, unlike a
      // synthetic DOM click/KeyboardEvent created inside the remote page.
      webContents.sendInputEvent({ type: "keyDown", keyCode: "ENTER" });
      webContents.sendInputEvent({ type: "keyUp", keyCode: "ENTER" });
    } catch (error) {
      return {
        ...result,
        ok: false,
        reason: "send_not_confirmed",
        fallback: "trusted-enter",
        message: String(error?.message || error)
      };
    }

    return this.waitForNativeSubmission(webContents);
  }

  async stopGeneration(webContents) {
    return this.request(webContents, "stop-generation");
  }

  async readAssistantSnapshot(webContents) {
    const result = await this.request(webContents, "read-assistant");
    if (!result?.ok) return result || { ok: false, reason: "assistant_snapshot_failed" };
    const text = Utils.normalizeText(result.text || "");
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > this.maxAssistantBytes) return { ok: false, reason: "assistant_response_too_large", bytes, maxBytes: this.maxAssistantBytes };
    const pathname = String(result.pathname || "");
    const messageCount = Math.max(0, Number(result.messageCount) || 0);
    return {
      ok: true,
      text,
      bytes,
      messageCount,
      pathname,
      url: String(result.url || ""),
      availability: String(result.availability || "unavailable"),
      generating: Boolean(result.generating),
      fingerprint: text ? Utils.hashString(`${pathname}:${messageCount}:${text}`) : ""
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
  DEFAULT_MAX_ASSISTANT_BYTES
};
