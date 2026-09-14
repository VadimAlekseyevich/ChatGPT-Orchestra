"use strict";

const { ipcRenderer } = require("electron");

const COMMAND_CHANNEL = "orchestra:agent:command";
const RESPONSE_CHANNEL = "orchestra:agent:response";
const MAX_PROMPT_CHARS = 120000;

function visible(element) {
  if (!element) return false;
  if (!globalThis.getComputedStyle || !element.getBoundingClientRect) return true;
  const style = globalThis.getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return style.display !== "none"
    && style.visibility !== "hidden"
    && rect.width > 0
    && rect.height > 0;
}

function queryFirst(selectors, predicate = () => true) {
  for (const selector of Array.isArray(selectors) ? selectors : []) {
    if (typeof selector !== "string" || !selector) continue;
    const candidates = Array.from(document.querySelectorAll(selector));
    const match = candidates.find((candidate) => predicate(candidate));
    if (match) return match;
  }
  return null;
}

function composer(selectors) { return queryFirst(selectors.composers); }
function stopButton(selectors) { return queryFirst(selectors.stopButtons, visible); }
function sendButton(selectors) { return queryFirst(selectors.sendButtons, (element) => visible(element) && !element.disabled); }
function errorIndicator(selectors) { return queryFirst(selectors.errorIndicators); }

function composerText(element) {
  if (!element) return "";
  if (typeof element.value === "string") return element.value;
  return element.innerText || element.textContent || "";
}

function availability(selectors) {
  if (stopButton(selectors)) return "generating";
  if (composer(selectors)) return "ready";
  if (errorIndicator(selectors)) return "error";
  return "unavailable";
}

function status(selectors) {
  let messageCount = 0;
  for (const selector of selectors.assistantMessages || []) {
    const messages = Array.from(document.querySelectorAll(selector));
    if (messages.length) { messageCount = messages.length; break; }
  }
  return {
    ok: true,
    availability: availability(selectors),
    generating: Boolean(stopButton(selectors)),
    messageCount,
    pathname: String(location.pathname || ""),
    url: String(location.href || "")
  };
}

function readAssistant(selectors) {
  let messages = [];
  for (const selector of selectors.assistantMessages || []) {
    const current = Array.from(document.querySelectorAll(selector));
    if (current.length) { messages = current; break; }
  }
  const last = messages.at(-1) || null;
  let body = null;
  if (last) {
    for (const selector of selectors.assistantBodies || []) {
      body = last.querySelector(selector);
      if (body) break;
    }
  }
  const source = body || last;
  return {
    ...status(selectors),
    text: source ? String(source.innerText || source.textContent || "") : ""
  };
}

function setNativeValue(element, value) {
  const prototype = Object.getPrototypeOf(element);
  const descriptor = prototype && Object.getOwnPropertyDescriptor(prototype, "value");
  if (descriptor?.set) descriptor.set.call(element, value);
  else element.value = value;
  element.dispatchEvent?.(new Event("input", { bubbles: true }));
  element.dispatchEvent?.(new Event("change", { bubbles: true }));
}

function setComposerText(element, text) {
  element?.focus?.();
  if (typeof element?.value === "string") {
    setNativeValue(element, text);
    return;
  }
  const selection = globalThis.getSelection?.();
  const range = document.createRange?.();
  if (selection && range) {
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);
  }
  let inserted = false;
  try { inserted = Boolean(document.execCommand?.("insertText", false, text)); } catch (_) { inserted = false; }
  if (!inserted || !composerText(element).trim()) {
    element.innerHTML = "";
    const paragraph = document.createElement("p");
    paragraph.textContent = text;
    element.appendChild(paragraph);
    if (typeof InputEvent === "function") {
      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    } else {
      element.dispatchEvent?.(new Event("input", { bubbles: true }));
    }
  } else {
    element.dispatchEvent?.(new Event("input", { bubbles: true }));
  }
}

async function sendPrompt(selectors, payload = {}) {
  if (stopButton(selectors)) return { ok: false, reason: "generation_in_progress" };
  const text = String(payload.prompt || "").trim();
  if (!text) return { ok: false, reason: "empty_prompt" };
  if (text.length > MAX_PROMPT_CHARS) return { ok: false, reason: "prompt_too_large", maxChars: MAX_PROMPT_CHARS };
  const input = composer(selectors);
  if (!input) return { ok: false, reason: errorIndicator(selectors) ? "chat_error" : "composer_unavailable" };
  if (composerText(input).trim()) return { ok: false, reason: "composer_occupied" };
  setComposerText(input, text);
  const timeoutMs = Math.max(250, Math.min(15000, Number(payload.timeoutMs) || 5000));
  const startedAt = Date.now();
  let button = sendButton(selectors);
  while (!button && Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    button = sendButton(selectors);
  }
  if (!button) return { ok: false, reason: "send_button_timeout" };
  button.click?.();
  return { ok: true, accepted: true, url: String(location.href || "") };
}

function stopGeneration(selectors) {
  const button = stopButton(selectors);
  if (!button) return { ok: false, reason: "not_generating" };
  button.click?.();
  return { ok: true, stopped: true, url: String(location.href || "") };
}

async function handleCommand(command = {}) {
  const selectors = command.selectors || {};
  if (command.name === "status") return status(selectors);
  if (command.name === "read-assistant") return readAssistant(selectors);
  if (command.name === "send-prompt") return sendPrompt(selectors, command.payload || {});
  if (command.name === "stop-generation") return stopGeneration(selectors);
  return { ok: false, reason: "unknown_agent_preload_command" };
}

ipcRenderer.on(COMMAND_CHANNEL, (_event, command = {}) => {
  const requestId = String(command.requestId || "");
  if (!requestId) return;
  Promise.resolve(handleCommand(command))
    .then((result) => ipcRenderer.send(RESPONSE_CHANNEL, { requestId, result }))
    .catch((error) => ipcRenderer.send(RESPONSE_CHANNEL, {
      requestId,
      result: { ok: false, reason: "agent_preload_command_failed", message: String(error?.message || error) }
    }));
});
