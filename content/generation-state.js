(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};

  class GenerationStateMachine {
    constructor({ quietMs = 700 } = {}) {
      this.quietMs = Math.max(100, Number(quietMs) || 700);
      this.initialized = false;
      this.state = "IDLE";
      this.lastFingerprint = "";
      this.lastCompletedFingerprint = "";
      this.lastActivityAt = 0;
      this.activeCandidate = false;
    }

    setQuietMs(quietMs) {
      this.quietMs = Math.max(100, Number(quietMs) || this.quietMs);
    }

    reset({ busy = false, fingerprint = "", now = Date.now() } = {}) {
      this.initialized = true;
      this.state = busy ? "GENERATING" : "IDLE";
      this.lastFingerprint = String(fingerprint || "");
      this.lastCompletedFingerprint = "";
      this.lastActivityAt = now;
      this.activeCandidate = Boolean(busy);
    }

    observe({ busy = false, fingerprint = "", now = Date.now() } = {}) {
      const events = [];
      const currentFingerprint = String(fingerprint || "");

      if (!this.initialized) {
        this.reset({ busy, fingerprint: currentFingerprint, now });
        if (busy) {
          events.push({ type: "generation_started", reason: "busy_at_start" });
        }
        return events;
      }

      const fingerprintChanged = Boolean(currentFingerprint)
        && currentFingerprint !== this.lastFingerprint;

      if (fingerprintChanged) {
        this.lastFingerprint = currentFingerprint;
        this.lastActivityAt = now;
        this.activeCandidate = true;
        events.push({ type: "response_changed", fingerprint: currentFingerprint });
      }

      if (busy) {
        if (this.state !== "GENERATING") {
          events.push({ type: "generation_started", reason: "busy_signal" });
        }
        this.state = "GENERATING";
        this.activeCandidate = true;
        this.lastActivityAt = now;
        return events;
      }

      if (this.state === "GENERATING") {
        this.state = "SETTLING";
        this.lastActivityAt = now;
        this.activeCandidate = true;
        events.push({ type: "generation_stopped" });
        return events;
      }

      if (this.activeCandidate && currentFingerprint) {
        this.state = "SETTLING";
        const stableFor = Math.max(0, now - this.lastActivityAt);

        if (stableFor >= this.quietMs && currentFingerprint !== this.lastCompletedFingerprint) {
          this.lastCompletedFingerprint = currentFingerprint;
          this.activeCandidate = false;
          this.state = "IDLE";
          events.push({
            type: "generation_completed",
            fingerprint: currentFingerprint,
            stableFor
          });
        }
      } else {
        this.state = "IDLE";
      }

      return events;
    }

    snapshot() {
      return {
        state: this.state,
        initialized: this.initialized,
        lastFingerprint: this.lastFingerprint,
        lastCompletedFingerprint: this.lastCompletedFingerprint,
        lastActivityAt: this.lastActivityAt,
        activeCandidate: this.activeCandidate,
        quietMs: this.quietMs
      };
    }
  }

  root.GenerationStateMachine = GenerationStateMachine;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = GenerationStateMachine;
  }
})();
