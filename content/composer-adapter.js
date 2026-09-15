(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};
  const Utils = root.Utils || (typeof require === "function" ? require("./utils.js") : null);
  const SELECTORS = root.SELECTORS || (typeof require === "function" ? require("./selectors.js") : null);

  class ComposerAdapter {
    constructor({
      documentRef = globalThis.document,
      windowRef = globalThis.window,
      sendTimeoutMs = 5000,
      submissionTimeoutMs = 1500
    } = {}) {
      this.documentRef = documentRef;
      this.windowRef = windowRef;
      this.sendTimeoutMs = Math.max(250, Number(sendTimeoutMs) || 5000);
      this.submissionTimeoutMs = Math.max(250, Number(submissionTimeoutMs) || 1500);
    }

    setSendTimeoutMs(sendTimeoutMs) {
      this.sendTimeoutMs = Math.max(250, Number(sendTimeoutMs) || this.sendTimeoutMs);
    }

    findStopButton() {
      return Utils.queryFirst(
        this.documentRef,
        SELECTORS.stopButtons,
        (element) => Utils.isVisible(element, this.windowRef)
      );
    }

    isGenerating() {
      return Boolean(this.findStopButton());
    }

    findComposer() {
      return Utils.queryFirst(this.documentRef, SELECTORS.composers);
    }

    getComposerText(composer = this.findComposer()) {
      if (!composer) return "";
      if (typeof composer.value === "string") return composer.value;
      return composer.innerText || composer.textContent || "";
    }

    isComposerOccupied() {
      const composer = this.findComposer();
      return composer ? Boolean(this.getComposerText(composer).trim()) : null;
    }

    setNativeValue(element, value) {
      const prototype = Object.getPrototypeOf(element);
      const descriptor = prototype && Object.getOwnPropertyDescriptor(prototype, "value");
      if (descriptor?.set) {
        descriptor.set.call(element, value);
      } else {
        element.value = value;
      }
      element.dispatchEvent?.(new Event("input", { bubbles: true }));
      element.dispatchEvent?.(new Event("change", { bubbles: true }));
    }

    setComposerText(composer, text) {
      composer?.focus?.();

      if (typeof composer?.value === "string") {
        this.setNativeValue(composer, text);
        return;
      }

      const selection = this.windowRef?.getSelection?.();
      const range = this.documentRef?.createRange?.();
      if (selection && range) {
        range.selectNodeContents(composer);
        selection.removeAllRanges();
        selection.addRange(range);
      }

      let inserted = false;
      try {
        inserted = Boolean(this.documentRef?.execCommand?.("insertText", false, text));
      } catch (_) {
        inserted = false;
      }

      if (!inserted || !this.getComposerText(composer).trim()) {
        composer.innerHTML = "";
        const paragraph = this.documentRef.createElement("p");
        paragraph.textContent = text;
        composer.appendChild(paragraph);
        if (typeof InputEvent === "function") {
          composer.dispatchEvent(new InputEvent("input", {
            bubbles: true,
            inputType: "insertText",
            data: text
          }));
        } else {
          composer.dispatchEvent?.(new Event("input", { bubbles: true }));
        }
      } else {
        composer.dispatchEvent?.(new Event("input", { bubbles: true }));
      }
    }

    findSendButton() {
      return Utils.queryFirst(
        this.documentRef,
        SELECTORS.sendButtons,
        (element) => Utils.isVisible(element, this.windowRef) && !element.disabled
      );
    }

    async waitForSendButton(timeoutMs = this.sendTimeoutMs) {
      const startedAt = Date.now();
      while (Date.now() - startedAt < timeoutMs) {
        const button = this.findSendButton();
        if (button) return button;
        await Utils.sleep(100);
      }
      return null;
    }

    pathname() {
      return String(this.windowRef?.location?.pathname || "");
    }

    submissionObserved(initialPathname = "") {
      if (this.isGenerating()) return true;
      if (initialPathname && this.pathname() && this.pathname() !== initialPathname) return true;
      const composer = this.findComposer();
      return Boolean(composer && !this.getComposerText(composer).trim());
    }

    async waitForSubmission(initialPathname = "", timeoutMs = this.submissionTimeoutMs) {
      const startedAt = Date.now();
      while (Date.now() - startedAt < timeoutMs) {
        if (this.submissionObserved(initialPathname)) return true;
        await Utils.sleep(50);
      }
      return this.submissionObserved(initialPathname);
    }

    hasErrorIndicator() {
      return Boolean(Utils.queryFirst(this.documentRef, SELECTORS.errorIndicators));
    }

    getAvailability() {
      if (this.isGenerating()) return "generating";
      if (this.findComposer()) return "ready";
      if (this.hasErrorIndicator()) return "error";
      return "unavailable";
    }

    async sendPrompt(prompt) {
      if (this.isGenerating()) {
        return { ok: false, reason: "generation_in_progress" };
      }

      const text = String(prompt || "").trim();
      if (!text) {
        return { ok: false, reason: "empty_prompt" };
      }

      const composer = this.findComposer();
      if (!composer) {
        return { ok: false, reason: this.hasErrorIndicator() ? "chat_error" : "composer_unavailable" };
      }

      if (this.getComposerText(composer).trim()) {
        return { ok: false, reason: "composer_occupied" };
      }

      const initialPathname = this.pathname();
      this.setComposerText(composer, text);
      const sendButton = await this.waitForSendButton();

      if (!sendButton) {
        return { ok: false, reason: "send_button_timeout", promptStaged: this.isComposerOccupied() === true };
      }

      sendButton.click?.();
      if (await this.waitForSubmission(initialPathname, Math.min(700, this.submissionTimeoutMs))) {
        return { ok: true, accepted: true, confirmed: true, method: "button-click" };
      }

      // Extension/content-script mode has no Electron trusted-input boundary. If a
      // synthetic click is ignored, request a normal form submission and confirm
      // state changed instead of claiming success just because click() returned.
      const form = sendButton.form || sendButton.closest?.("form") || null;
      if (typeof form?.requestSubmit === "function") {
        try { form.requestSubmit(sendButton); } catch (_) {}
        if (await this.waitForSubmission(initialPathname)) {
          return { ok: true, accepted: true, confirmed: true, method: "form-request-submit" };
        }
      }

      return { ok: false, reason: "send_not_confirmed", promptStaged: this.isComposerOccupied() === true };
    }

    stopGeneration() {
      const button = this.findStopButton();
      if (!button) return { ok: false, reason: "not_generating" };
      button.click?.();
      return { ok: true };
    }
  }

  root.ComposerAdapter = ComposerAdapter;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = ComposerAdapter;
  }
})();
