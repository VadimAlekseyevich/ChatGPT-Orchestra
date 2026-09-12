(() => {
  "use strict";

  const DEFAULT_RULES = [
    {
      id: "done",
      enabled: true,
      marker: "DONE",
      action: "prompt",
      prompt: "Делай следующее задание"
    },
    {
      id: "fail",
      enabled: true,
      marker: "FAIL",
      action: "notify",
      prompt: "Требуется ваше участие. Откройте чат ChatGPT."
    },
    {
      id: "error",
      enabled: true,
      marker: "ERROR",
      action: "prompt",
      prompt: "Исправь ошибку и продолжи работу. Если без моего участия продолжить нельзя, заверши ответ флагом FAIL."
    }
  ];

  const DEFAULTS = {
    enabled: true,
    delayMs: 1200,
    delayRandomMs: 1200,
    stableMs: 650,
    sendTimeoutMs: 5000
  };

  const LEGACY_DEFAULT_MARKER = "DONE";
  const LEGACY_DEFAULT_FOLLOW_UP = "Делай следующее задание";
  const LOG_PREFIX = "[ChatGPT DONE Auto-Continue]";

  let config = { ...DEFAULTS, rules: cloneDefaultRules() };
  let wasGenerating = false;
  let pendingRun = null;
  let lastHandledKey = "";
  let observerStarted = false;

  function cloneDefaultRules() {
    return DEFAULT_RULES.map((rule) => ({ ...rule }));
  }

  function log(...args) {
    console.debug(LOG_PREFIX, ...args);
  }

  function normalizeRule(rule, index) {
    if (!rule || typeof rule !== "object") return null;

    const marker = String(rule.marker || "").trim();
    if (!marker) return null;

    const action = rule.action === "notify" ? "notify" : "prompt";
    const prompt = String(rule.prompt || "").trim();

    return {
      id: String(rule.id || `rule-${index}-${marker}`),
      enabled: rule.enabled !== false,
      marker,
      action,
      prompt
    };
  }

  function normalizeRules(rules, legacyMarker, legacyFollowUp) {
    if (Array.isArray(rules)) {
      return rules
        .map(normalizeRule)
        .filter(Boolean);
    }

    const migrated = cloneDefaultRules();
    migrated[0].marker = String(legacyMarker || LEGACY_DEFAULT_MARKER).trim() || LEGACY_DEFAULT_MARKER;
    migrated[0].prompt = String(legacyFollowUp || LEGACY_DEFAULT_FOLLOW_UP).trim() || LEGACY_DEFAULT_FOLLOW_UP;
    return migrated;
  }

  async function loadConfig() {
    try {
      const stored = await chrome.storage.local.get([
        "enabled",
        "rules",
        "marker",
        "followUp",
        "delayMs",
        "delayRandomMs",
        "stableMs",
        "sendTimeoutMs"
      ]);

      config = {
        ...DEFAULTS,
        ...stored,
        rules: normalizeRules(stored.rules, stored.marker, stored.followUp)
      };
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

  function getLastNonEmptyLine(text) {
    const normalizedText = normalizeText(text);
    if (!normalizedText) return "";

    const lines = normalizedText
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    return lines.at(-1) || "";
  }

  function findMatchingRule(text) {
    const lastLine = getLastNonEmptyLine(text);
    if (!lastLine) return null;

    return config.rules.find((rule) => rule.enabled && rule.marker === lastLine) || null;
  }

  function hashString(value) {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i += 1) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
  }

  function currentHandledKey(text, rule) {
    return `${location.pathname}:${rule.id}:${hashString(text)}`;
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

  async function sendPrompt(prompt) {
    if (!config.enabled || isGenerating()) return false;

    const text = String(prompt || "").trim();
    if (!text) {
      console.warn(LOG_PREFIX, "Matched rule has an empty prompt; auto-send skipped.");
      return false;
    }

    const composer = getComposer();
    if (!composer) {
      console.warn(LOG_PREFIX, "Composer was not found.");
      return false;
    }

    if (getComposerText(composer).trim()) {
      console.warn(LOG_PREFIX, "Composer already contains text; auto-send skipped to avoid overwriting it.");
      return false;
    }

    setComposerText(composer, text);
    const sendButton = await waitForSendButton(config.sendTimeoutMs);

    if (!sendButton) {
      console.warn(LOG_PREFIX, "Send button did not become available.");
      return false;
    }

    sendButton.click();
    log("Follow-up sent:", text);
    return true;
  }

  async function notifyUser(rule) {
    const message = String(rule.prompt || "").trim()
      || "ChatGPT остановил автопродолжение и ждёт вашего участия.";

    window.focus();
    window.alert(`${rule.marker}: ${message}`);
    log("User notified for marker:", rule.marker);
    return true;
  }

  async function handleRule(rule) {
    if (rule.action === "notify") {
      return notifyUser(rule);
    }
    return sendPrompt(rule.prompt);
  }

  async function processCompletedGeneration() {
    pendingRun = null;

    if (!config.enabled || isGenerating()) return;

    const firstText = getLastAssistantText();
    const firstRule = findMatchingRule(firstText);
    if (!firstRule) {
      log("Generation finished, but the last non-empty line does not match an enabled rule.");
      return;
    }

    await sleep(Math.max(250, Number(config.stableMs) || DEFAULTS.stableMs));

    if (!config.enabled || isGenerating()) return;

    const stableText = getLastAssistantText();
    const stableRule = findMatchingRule(stableText);
    if (stableText !== firstText || !stableRule || stableRule.id !== firstRule.id) {
      log("Assistant text or matched rule changed during stability check; skipping this pass.");
      return;
    }

    const handledKey = currentHandledKey(stableText, stableRule);
    if (handledKey === lastHandledKey) {
      log("This flagged response was already handled.");
      return;
    }

    lastHandledKey = handledKey;
    const handled = await handleRule(stableRule);

    if (!handled) {
      lastHandledKey = "";
    }
  }

  function getCompletedGenerationDelayMs() {
    const baseDelay = Math.max(300, Number(config.delayMs) || DEFAULTS.delayMs);
    const randomWindow = Math.max(0, Number(config.delayRandomMs) || 0);
    const randomExtra = randomWindow > 0
      ? Math.floor(Math.random() * (randomWindow + 1))
      : 0;
    return baseDelay + randomExtra;
  }

  function scheduleCompletedGenerationCheck() {
    if (pendingRun) clearTimeout(pendingRun);

    const delay = getCompletedGenerationDelayMs();
    log("Flag check scheduled in", delay, "ms.");
    pendingRun = setTimeout(processCompletedGeneration, delay);
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
      log("Generation finished. Checking flag after randomized delay.");
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

    setInterval(inspectGenerationState, 750);
    log("Monitoring started.", config);
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;

    if (changes.rules) {
      config.rules = normalizeRules(changes.rules.newValue);
    }

    for (const key of ["enabled", "delayMs", "delayRandomMs", "stableMs", "sendTimeoutMs"]) {
      if (changes[key]) config[key] = changes[key].newValue;
    }

    log("Settings updated.", config);
  });

  (async () => {
    await loadConfig();
    startObserver();
  })();
})();
