(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};

  function normalizeText(text) {
    return String(text || "")
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .replace(/\r\n/g, "\n")
      .trimEnd();
  }

  function getLastNonEmptyLine(text) {
    const normalized = normalizeText(text);
    if (!normalized) return "";

    const lines = normalized
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    return lines.at(-1) || "";
  }

  function hashString(value) {
    let hash = 2166136261;
    const text = String(value || "");

    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }

    return (hash >>> 0).toString(16);
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function isVisible(element, windowRef = globalThis.window) {
    if (!element) return false;
    if (!windowRef?.getComputedStyle || !element.getBoundingClientRect) return true;

    const style = windowRef.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none"
      && style.visibility !== "hidden"
      && rect.width > 0
      && rect.height > 0;
  }

  function queryFirst(documentRef, selectors, predicate = () => true) {
    if (!documentRef) return null;

    for (const selector of selectors || []) {
      const candidates = Array.from(documentRef.querySelectorAll(selector));
      const match = candidates.find((candidate) => predicate(candidate));
      if (match) return match;
    }

    return null;
  }

  root.Utils = Object.freeze({
    normalizeText,
    getLastNonEmptyLine,
    hashString,
    sleep,
    isVisible,
    queryFirst
  });

  if (typeof module !== "undefined" && module.exports) {
    module.exports = root.Utils;
  }
})();
