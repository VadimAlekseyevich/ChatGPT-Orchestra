(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};
  const GenerationStateMachine = root.GenerationStateMachine
    || (typeof require === "function" ? require("./generation-state.js") : null);

  class GenerationDetector {
    constructor({
      documentRef = globalThis.document,
      windowRef = globalThis.window,
      reader,
      composer,
      logger = root.Logger,
      quietMs = 700,
      pollMs = 500,
      clock = () => Date.now()
    } = {}) {
      this.documentRef = documentRef;
      this.windowRef = windowRef;
      this.reader = reader;
      this.composer = composer;
      this.logger = logger;
      this.clock = clock;
      this.pollMs = Math.max(200, Number(pollMs) || 500);
      this.machine = new GenerationStateMachine({ quietMs });
      this.listeners = new Set();
      this.observer = null;
      this.pollHandle = null;
      this.framePending = false;
      this.started = false;
      this.lastPathname = null;
    }

    setQuietMs(quietMs) {
      this.machine.setQuietMs(quietMs);
    }

    onEvent(listener) {
      if (typeof listener !== "function") return () => {};
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    }

    emit(event, snapshot) {
      const enriched = {
        ...event,
        snapshot,
        detectorState: this.machine.snapshot()
      };

      for (const listener of this.listeners) {
        try {
          listener(enriched);
        } catch (error) {
          this.logger?.error?.("generation_detector_listener_error", error);
        }
      }
    }

    inspect(reason = "poll") {
      if (!this.started) return;

      const snapshot = this.reader.getSnapshot();
      const busy = this.composer.isGenerating();
      const now = this.clock();

      if (this.lastPathname === null) {
        this.lastPathname = snapshot.pathname;
      } else if (snapshot.pathname !== this.lastPathname) {
        const previousPathname = this.lastPathname;
        this.lastPathname = snapshot.pathname;

        // ChatGPT is an SPA. Navigating to another existing conversation changes
        // the rendered response without creating a new generation. Treat that
        // response as a new baseline instead of falsely emitting completion.
        this.machine.reset({
          busy,
          fingerprint: snapshot.fingerprint,
          now
        });
        this.logger?.debug?.("conversation_navigation_baseline", {
          reason,
          from: previousPathname,
          to: snapshot.pathname,
          busy,
          fingerprint: snapshot.fingerprint
        });
        this.emit({ type: "conversation_changed" }, snapshot);
        return;
      }

      const events = this.machine.observe({
        busy,
        fingerprint: snapshot.fingerprint,
        now
      });

      for (const event of events) {
        if (event.type === "generation_completed") {
          this.logger?.info?.("assistant_response_completed", {
            reason,
            fingerprint: snapshot.fingerprint,
            messageCount: snapshot.messageCount,
            stableFor: event.stableFor
          });
        } else if (event.type === "generation_started" || event.type === "generation_stopped") {
          this.logger?.debug?.(event.type, { reason, fingerprint: snapshot.fingerprint });
        }
        this.emit(event, snapshot);
      }
    }

    scheduleInspect(reason = "mutation") {
      if (this.framePending || !this.started) return;
      this.framePending = true;

      const schedule = this.windowRef?.requestAnimationFrame
        ? (callback) => this.windowRef.requestAnimationFrame(callback)
        : (callback) => setTimeout(callback, 0);

      schedule(() => {
        this.framePending = false;
        this.inspect(reason);
      });
    }

    start() {
      if (this.started || !this.documentRef?.documentElement) return;
      this.started = true;

      // Establish a baseline immediately. An already completed response must not
      // be treated as a fresh completion merely because the extension loaded.
      this.inspect("startup");

      if (typeof MutationObserver === "function") {
        this.observer = new MutationObserver(() => this.scheduleInspect("mutation"));
        this.observer.observe(this.documentRef.documentElement, {
          childList: true,
          subtree: true,
          characterData: true,
          attributes: true,
          attributeFilter: ["disabled", "data-testid", "aria-label"]
        });
      }

      this.pollHandle = setInterval(() => this.inspect("poll"), this.pollMs);
      this.logger?.info?.("generation_detector_started", {
        pollMs: this.pollMs,
        quietMs: this.machine.quietMs
      });
    }

    stop() {
      this.started = false;
      this.observer?.disconnect?.();
      this.observer = null;
      if (this.pollHandle) clearInterval(this.pollHandle);
      this.pollHandle = null;
      this.framePending = false;
      this.lastPathname = null;
    }
  }

  root.GenerationDetector = GenerationDetector;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = GenerationDetector;
  }
})();
