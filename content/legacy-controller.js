(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};
  const Utils = root.Utils;

  const DEFAULT_RULES = Object.freeze([
    Object.freeze({
      id: "done",
      enabled: true,
      marker: "DONE",
      action: "prompt",
      prompt: "Делай следующее задание"
    }),
    Object.freeze({
      id: "fail",
      enabled: true,
      marker: "FAIL",
      action: "notify",
      prompt: "Требуется ваше участие. Откройте чат ChatGPT."
    }),
    Object.freeze({
      id: "error",
      enabled: true,
      marker: "ERROR",
      action: "prompt",
      prompt: "Исправь ошибку и продолжи работу. Если без моего участия продолжить нельзя, заверши ответ флагом FAIL."
    })
  ]);

  const DEFAULTS = Object.freeze({
    enabled: true,
    delayMs: 1200,
    delayRandomMs: 1200,
    stableMs: 650,
    sendTimeoutMs: 5000
  });

  const LEGACY_DEFAULT_MARKER = "DONE";
  const LEGACY_DEFAULT_FOLLOW_UP = "Делай следующее задание";

  class LegacyController {
    constructor({
      adapter,
      storage = globalThis.chrome?.storage,
      windowRef = globalThis.window,
      logger = root.Logger
    } = {}) {
      this.adapter = adapter;
      this.storage = storage;
      this.windowRef = windowRef;
      this.logger = logger;
      this.config = { ...DEFAULTS, rules: this.cloneDefaultRules() };
      this.pendingRun = null;
      this.lastHandledKey = "";
      this.storageListener = null;
    }

    cloneDefaultRules() {
      return DEFAULT_RULES.map((rule) => ({ ...rule }));
    }

    normalizeRule(rule, index) {
      if (!rule || typeof rule !== "object") return null;
      const marker = String(rule.marker || "").trim();
      if (!marker) return null;

      return {
        id: String(rule.id || `rule-${index}-${marker}`),
        enabled: rule.enabled !== false,
        marker,
        action: rule.action === "notify" ? "notify" : "prompt",
        prompt: String(rule.prompt || "").trim()
      };
    }

    normalizeRules(rules, legacyMarker, legacyFollowUp) {
      if (Array.isArray(rules)) {
        return rules.map((rule, index) => this.normalizeRule(rule, index)).filter(Boolean);
      }

      const migrated = this.cloneDefaultRules();
      migrated[0].marker = String(legacyMarker || LEGACY_DEFAULT_MARKER).trim() || LEGACY_DEFAULT_MARKER;
      migrated[0].prompt = String(legacyFollowUp || LEGACY_DEFAULT_FOLLOW_UP).trim() || LEGACY_DEFAULT_FOLLOW_UP;
      return migrated;
    }

    async loadConfig() {
      try {
        const stored = await this.storage.local.get([
          "enabled",
          "rules",
          "marker",
          "followUp",
          "delayMs",
          "delayRandomMs",
          "stableMs",
          "sendTimeoutMs"
        ]);

        this.config = {
          ...DEFAULTS,
          ...stored,
          rules: this.normalizeRules(stored.rules, stored.marker, stored.followUp)
        };
      } catch (error) {
        this.logger.warn("config_load_failed", { message: error?.message || String(error) });
      }

      this.adapter.configure({
        // Detector quiet time should be at least as strict as the configured
        // stability guard, but is kept separate from the randomized action delay.
        quietMs: Math.max(500, Number(this.config.stableMs) || DEFAULTS.stableMs),
        sendTimeoutMs: this.config.sendTimeoutMs
      });
    }

    getCompletedGenerationDelayMs() {
      const baseDelay = Math.max(300, Number(this.config.delayMs) || DEFAULTS.delayMs);
      const randomWindow = Math.max(0, Number(this.config.delayRandomMs) || 0);
      const randomExtra = randomWindow > 0
        ? Math.floor(Math.random() * (randomWindow + 1))
        : 0;
      return baseDelay + randomExtra;
    }

    cancelPending(reason) {
      if (!this.pendingRun) return;
      clearTimeout(this.pendingRun);
      this.pendingRun = null;
      this.logger.debug("legacy_check_cancelled", { reason });
    }

    scheduleCompletedGenerationCheck(sourceEvent) {
      this.cancelPending("reschedule");
      if (!this.config.enabled) return;

      const delay = this.getCompletedGenerationDelayMs();
      this.logger.debug("legacy_flag_check_scheduled", {
        delay,
        fingerprint: sourceEvent?.snapshot?.fingerprint || ""
      });

      this.pendingRun = setTimeout(() => {
        this.processCompletedGeneration(sourceEvent).catch((error) => {
          this.logger.error("legacy_flag_check_failed", error);
        });
      }, delay);
    }

    async handleRule(rule) {
      if (rule.action === "notify") {
        const message = String(rule.prompt || "").trim()
          || "ChatGPT остановил автопродолжение и ждёт вашего участия.";
        this.windowRef?.focus?.();
        this.windowRef?.alert?.(`${rule.marker}: ${message}`);
        this.logger.info("legacy_user_notified", { marker: rule.marker });
        return { ok: true };
      }

      const result = await this.adapter.sendPrompt(rule.prompt);
      if (result.ok) {
        this.logger.info("legacy_follow_up_sent", { marker: rule.marker });
      } else {
        this.logger.warn("legacy_follow_up_skipped", {
          marker: rule.marker,
          reason: result.reason
        });
      }
      return result;
    }

    async processCompletedGeneration(sourceEvent) {
      this.pendingRun = null;
      if (!this.config.enabled || this.adapter.isGenerating()) return;

      const first = this.adapter.getResponseSnapshot();
      const firstParsed = this.adapter.parseResponse(first.text, { rules: this.config.rules });

      if (firstParsed.kind !== "legacy_rule") {
        this.logger.debug("legacy_flag_not_matched", {
          kind: firstParsed.kind,
          lastLine: firstParsed.lastLine,
          fingerprint: first.fingerprint,
          sourceFingerprint: sourceEvent?.snapshot?.fingerprint || ""
        });
        return;
      }

      await Utils.sleep(Math.max(250, Number(this.config.stableMs) || DEFAULTS.stableMs));
      if (!this.config.enabled || this.adapter.isGenerating()) return;

      const stable = this.adapter.getResponseSnapshot();
      const stableParsed = this.adapter.parseResponse(stable.text, { rules: this.config.rules });

      if (
        stable.fingerprint !== first.fingerprint
        || stableParsed.kind !== "legacy_rule"
        || stableParsed.rule.id !== firstParsed.rule.id
      ) {
        this.logger.debug("legacy_response_changed_during_stability_check", {
          firstFingerprint: first.fingerprint,
          stableFingerprint: stable.fingerprint
        });
        return;
      }

      const handledKey = `${stable.pathname}:${stableParsed.rule.id}:${stable.fingerprint}`;
      if (handledKey === this.lastHandledKey) {
        this.logger.debug("legacy_duplicate_suppressed", { handledKey });
        return;
      }

      const result = await this.handleRule(stableParsed.rule);
      if (result.ok) {
        this.lastHandledKey = handledKey;
      }
    }

    onGenerationEvent(event) {
      if (event.type === "generation_started") {
        this.cancelPending("new_generation_started");
        return;
      }

      if (event.type === "generation_completed") {
        this.scheduleCompletedGenerationCheck(event);
      }
    }

    bindStorageChanges() {
      if (!this.storage?.onChanged?.addListener) return;

      this.storageListener = (changes, areaName) => {
        if (areaName !== "local") return;

        if (changes.rules) {
          this.config.rules = this.normalizeRules(changes.rules.newValue);
        }

        for (const key of ["enabled", "delayMs", "delayRandomMs", "stableMs", "sendTimeoutMs"]) {
          if (changes[key]) this.config[key] = changes[key].newValue;
        }

        this.adapter.configure({
          quietMs: Math.max(500, Number(this.config.stableMs) || DEFAULTS.stableMs),
          sendTimeoutMs: this.config.sendTimeoutMs
        });

        this.logger.info("legacy_settings_updated", {
          enabled: this.config.enabled,
          ruleCount: this.config.rules.length,
          delayMs: this.config.delayMs,
          delayRandomMs: this.config.delayRandomMs,
          stableMs: this.config.stableMs
        });
      };

      this.storage.onChanged.addListener(this.storageListener);
    }

    async start() {
      await this.loadConfig();
      this.bindStorageChanges();
      this.adapter.start((event) => this.onGenerationEvent(event));
      this.logger.info("legacy_controller_started", {
        enabled: this.config.enabled,
        ruleCount: this.config.rules.length
      });
    }

    stop() {
      this.cancelPending("controller_stopped");
      this.adapter.stop();
      if (this.storageListener && this.storage?.onChanged?.removeListener) {
        this.storage.onChanged.removeListener(this.storageListener);
      }
      this.storageListener = null;
    }
  }

  root.LegacyController = LegacyController;
  root.LEGACY_DEFAULTS = DEFAULTS;
  root.LEGACY_DEFAULT_RULES = DEFAULT_RULES;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { LegacyController, DEFAULTS, DEFAULT_RULES };
  }
})();
