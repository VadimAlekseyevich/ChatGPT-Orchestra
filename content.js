(() => {
  "use strict";

  const DEFAULTS = {
    enabled: true,
    marker: "DONE",
    followUp: "Делай следующее задание",
    delayMs: 1200,
    stableMs: 650,
    sendTimeoutMs: 5000
  };

  const LOG_PREFIX = "[ChatGPT DONE Auto-Continue]";
  let config = { ...DEFAULTS };
  let wasGenerating = false;
  let pendingRun = null;
  let lastHandledKey = "";
  let observerStarted = false;

  function log(...args) {
    console.debug(LOG_PREFIX, ...args);
  }

  async function loadConfig() {
    try {
      const stored = await chrome.storage.local.get(DEFAULTS);
      config = { ...DEFAULTS, ...stored };
    } catch (error) {
      console.warn(LOG_PREFIX, "Could not load settings; using defaults.", error);
    }
  }

  function isVisible(element) {
    if (!element) return false;
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  }

  function findStopButton() {
    const selectors = [
      'button[data-testid="stop-button"]',
      '[role="button"][data-testid="stop-button"]',
      'button[aria-label="Stop streaming"]',
      'button[aria-label="Stop generating"]',
      'button[aria-label*="Stop" i][data-testid]'
    ];

    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (element && isVisible(element)) return element;
    }
    return null;
  }

  function isGenerating() {
    return Boolean(findStopButton());
  }

  function getAssistantMessages() {
    const primary = Array.from(document.querySelectorAll('[data-message-author-role="assistant"]'));
    if (primary.length) return primary;

    return Array.from(document.querySelectorAll('article[data-turn="assistant"], article[data-message-author-role="assistant"]'));
  }

  function normalizeText(text) {
    return String(text || "")
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .replace(/\r\n/g, "\n")
      .trimEnd();
  }

  function getLastAssistantText() {
    const messages = getAssistantMessages();
    const last = messages.at(-1);
    if (!last) return "";

    const body = last.querySelector('.markdown, [class*="markdown"], [data-message-content]') || last;
    return normalizeText(body.innerText || body.textContent || "");
  }

  function endsWithMarker(text, marker) {
    const normalizedText = normalizeText(text);
    const normalizedMarker = normalizeText(marker).trim();
    if (!normalizedText || !normalizedMarker) return false;

    const lines = normalizedText
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    return lines.at(-1) === normalizedMarker;
  }

  function hashString(value) {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i += 1) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
  }

  function currentHandledKey(text) {
    return `${location.pathname}:${hashString(text)}`;
  }

  function getComposer() {
    return (
      document.querySelector('#prompt-textarea') ||
      document.querySelector('textarea[name="prompt-textarea"]') ||
      document.querySelector('textarea#prompt-textarea')
    );
  }

  function getComposerText(composer) {
    if (!composer) return "";
    if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
      return composer.value || "";
    }
    return composer.innerText || composer.textContent || "";
  }

  function setNativeTextareaValue(element, value) {
    const prototype = Object.getPrototypeOf(element);
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
    if (descriptor?.set) {
      descriptor.set.call(element, value);
    } else {
      element.value = value;
    }
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function setComposerText(composer, text) {
    composer.focus();

    if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
      setNativeTextareaValue(composer, text);
      return;
    }

    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(composer);
    selection.removeAllRanges();
    selection.addRange(range);

    let inserted = false;
    try {
      inserted = document.execCommand("insertText", false, text);
    } catch (_) {
      inserted = false;
    }

    if (!inserted || !getComposerText(composer).trim()) {
      composer.innerHTML = "";
      const paragraph = document.createElement("p");
      paragraph.textContent = text;
      composer.appendChild(paragraph);
      composer.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: text
      }));
    } else {
      composer.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }

  function findSendButton() {
    const selectors = [
      '#composer-submit-button',
      'button[data-testid="send-button"]',
      'button[aria-label="Send prompt"]',
      'button.composer-submit-btn'
    ];

    for (const selector of selectors) {
      const candidates = Array.from(document.querySelectorAll(selector));
      const button = candidates.find((element) => isVisible(element) && !element.disabled);
      if (button) return button;
    }
    return null;
  }

  async function waitForSendButton(timeoutMs) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const button = findSendButton();
      if (button) return button;
      await sleep(100);
    }
    return null;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function sendFollowUp() {
    if (!config.enabled || isGenerating()) return false;

    const composer = getComposer();
    if (!composer) {
      console.warn(LOG_PREFIX, "Composer was not found.");
      return false;
    }

    if (getComposerText(composer).trim()) {
      console.warn(LOG_PREFIX, "Composer already contains text; auto-send skipped to avoid overwriting it.");
      return false;
    }

    setComposerText(composer, config.followUp);
    const sendButton = await waitForSendButton(config.sendTimeoutMs);

    if (!sendButton) {
      console.warn(LOG_PREFIX, "Send button did not become available.");
      return false;
    }

    sendButton.click();
    log("Follow-up sent:", config.followUp);
    return true;
  }

  async function processCompletedGeneration() {
    pendingRun = null;

    if (!config.enabled || isGenerating()) return;

    const firstText = getLastAssistantText();
    if (!endsWithMarker(firstText, config.marker)) {
      log("Generation finished, but the last non-empty line is not the marker.");
      return;
    }

    await sleep(Math.max(250, Number(config.stableMs) || DEFAULTS.stableMs));

    if (!config.enabled || isGenerating()) return;

    const stableText = getLastAssistantText();
    if (stableText !== firstText || !endsWithMarker(stableText, config.marker)) {
      log("Assistant text changed during stability check; skipping this pass.");
      return;
    }

    const handledKey = currentHandledKey(stableText);
    if (handledKey === lastHandledKey) {
      log("This DONE response was already handled.");
      return;
    }

    // Mark before clicking Send so a UI mutation cannot schedule the same response twice.
    lastHandledKey = handledKey;
    const sent = await sendFollowUp();

    if (!sent) {
      // Allow a future genuine generation-state transition to retry.
      lastHandledKey = "";
    }
  }

  function scheduleCompletedGenerationCheck() {
    if (pendingRun) clearTimeout(pendingRun);
    pendingRun = setTimeout(
      processCompletedGeneration,
      Math.max(300, Number(config.delayMs) || DEFAULTS.delayMs)
    );
  }

  function inspectGenerationState() {
    if (!config.enabled) {
      wasGenerating = isGenerating();
      return;
    }

    const generating = isGenerating();

    if (generating && !wasGenerating) {
      wasGenerating = true;
      if (pendingRun) {
        clearTimeout(pendingRun);
        pendingRun = null;
      }
      log("Generation detected.");
      return;
    }

    if (!generating && wasGenerating) {
      wasGenerating = false;
      log("Generation finished. Checking marker after delay.");
      scheduleCompletedGenerationCheck();
    }
  }

  function startObserver() {
    if (observerStarted || !document.documentElement) return;
    observerStarted = true;

    wasGenerating = isGenerating();

    let scheduled = false;
    const observer = new MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        inspectGenerationState();
      });
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["disabled", "data-testid", "aria-label"]
    });

    // Fallback polling protects against UI changes that do not trigger a useful mutation.
    setInterval(inspectGenerationState, 750);
    log("Monitoring started.", config);
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    for (const [key, change] of Object.entries(changes)) {
      config[key] = change.newValue;
    }
    log("Settings updated.", config);
  });

  (async () => {
    await loadConfig();
    startObserver();
  })();
})();
