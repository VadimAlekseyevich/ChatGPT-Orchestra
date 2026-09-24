"use strict";

const RETRYABLE_PREPARE_REASONS = new Set(["agent_preload_timeout", "agent_preload_send_failed"]);
const {
  normalizeTraceContext,
  traceDetails,
  traceDurationMs,
  byteLength,
  snapshotMetadata
} = require("./runtime-trace.js");

class ManagedBrowserCompletionMonitor {
  constructor({
    driver,
    protocolAdapter,
    pollMs = 400,
    quietMs = 1200,
    timeoutMs = 30 * 60 * 1000,
    maxSnapshotErrors = 50,
    snapshotErrorGraceMs = 30_000,
    prepareAttempts = 2,
    prepareRetryMs = 250,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    clock = () => Date.now(),
    logger = console
  } = {}) {
    if (typeof driver?.readAssistantSnapshot !== "function") throw new TypeError("managed_browser_snapshot_reader_required");
    if (typeof protocolAdapter?.publishCompletion !== "function" || typeof protocolAdapter?.publishProtocolError !== "function") {
      throw new TypeError("managed_browser_protocol_adapter_required");
    }
    this.driver = driver;
    this.protocolAdapter = protocolAdapter;
    this.pollMs = Math.max(100, Number(pollMs) || 400);
    this.quietMs = Math.max(this.pollMs, Number(quietMs) || 1200);
    this.timeoutMs = Math.max(this.quietMs + this.pollMs, Number(timeoutMs) || (30 * 60 * 1000));
    this.maxSnapshotErrors = Math.max(1, Math.min(100, Number(maxSnapshotErrors) || 50));
    this.snapshotErrorGraceMs = Math.max(this.pollMs, Math.min(120_000, Number(snapshotErrorGraceMs) || 30_000));
    this.prepareAttempts = Math.max(1, Math.min(4, Number(prepareAttempts) || 2));
    this.prepareRetryMs = Math.max(0, Math.min(2000, Number(prepareRetryMs) || 250));
    this.sleep = sleep;
    this.clock = clock;
    this.logger = logger;
    this.active = new Map();
    this.closed = false;
    this.nextToken = 1;
  }

  async prepare(runtime, agentId, traceContext = null) {
    const agent = runtime?.getAgent?.(agentId) || null;
    const sessionId = runtime?.sessionIdForAgent?.(agent);
    const trace = normalizeTraceContext(traceContext || agent?.protocolContext, {
      agentId: agent?.agentId || String(agentId || ""),
      sessionId
    });
    this.logger?.info?.("managed_browser_completion_prepare_started", traceDetails(trace, {
      maxAttempts: this.prepareAttempts
    }));

    if (this.closed) {
      this.logger?.warn?.("managed_browser_completion_prepare_failed", traceDetails(trace, {
        reason: "completion_monitor_closed",
        attempts: 0
      }));
      return { ok: false, reason: "completion_monitor_closed", trace };
    }
    if (!agent) {
      this.logger?.warn?.("managed_browser_completion_prepare_failed", traceDetails(trace, {
        reason: "completion_monitor_agent_missing",
        attempts: 0
      }));
      return { ok: false, reason: "completion_monitor_agent_missing", agentId: String(agentId || ""), trace };
    }
    if (!sessionId) {
      this.logger?.warn?.("managed_browser_completion_prepare_failed", traceDetails(trace, {
        reason: "completion_monitor_agent_offline",
        attempts: 0
      }));
      return { ok: false, reason: "completion_monitor_agent_offline", agentId: agent.agentId, trace };
    }

    let baseline = null;
    let attempts = 0;
    while (attempts < this.prepareAttempts) {
      attempts += 1;
      baseline = await this.driver.readAssistantSnapshot(sessionId, { trace });
      if (baseline?.ok) break;
      const reason = String(baseline?.reason || "");
      if (!RETRYABLE_PREPARE_REASONS.has(reason) || attempts >= this.prepareAttempts) break;
      if (this.prepareRetryMs > 0) await this.sleep(this.prepareRetryMs);
    }

    if (!baseline?.ok) {
      const reason = baseline?.reason || "completion_monitor_baseline_unavailable";
      this.logger?.warn?.("managed_browser_completion_prepare_failed", traceDetails(trace, {
        reason,
        attempts,
        availability: baseline?.availability || null,
        generating: baseline?.generating === true,
        pathname: String(baseline?.pathname || "")
      }));
      return {
        ok: false,
        reason,
        agentId: agent.agentId,
        sessionId,
        attempts,
        trace
      };
    }
    const normalized = this.normalizeSnapshot(baseline);
    this.logger?.info?.("managed_browser_completion_prepare_completed", traceDetails(trace, {
      ...snapshotMetadata(normalized),
      attempts
    }));
    return {
      ok: true,
      agentId: agent.agentId,
      sessionId: String(sessionId),
      baseline: normalized,
      attempts,
      trace
    };
  }

  normalizeSnapshot(snapshot = {}) {
    return {
      ...snapshot,
      ok: snapshot.ok !== false,
      text: String(snapshot.text || ""),
      fingerprint: String(snapshot.fingerprint || ""),
      messageCount: Math.max(0, Number(snapshot.messageCount) || 0),
      pathname: String(snapshot.pathname || ""),
      url: String(snapshot.url || ""),
      availability: String(snapshot.availability || "unavailable"),
      generating: Boolean(snapshot.generating)
    };
  }

  start(runtime, agentId, prepared) {
    if (!prepared?.ok) return { ok: false, reason: prepared?.reason || "completion_monitor_not_prepared" };
    if (this.closed) return { ok: false, reason: "completion_monitor_closed" };
    const id = String(agentId || prepared.agentId || "");
    this.cancel(id, "completion_monitor_replaced");
    const trace = normalizeTraceContext(prepared.trace, {
      agentId: id,
      sessionId: prepared.sessionId
    });
    const control = {
      token: this.nextToken++,
      agentId: id,
      sessionId: String(prepared.sessionId || ""),
      trace,
      cancelled: false,
      cancelReason: null,
      promise: null
    };
    control.promise = this.run(runtime, id, { ...prepared, trace }, control)
      .catch((error) => {
        this.logger?.warn?.("managed_browser_completion_monitor_failed", traceDetails(trace, {
          message: String(error?.message || error)
        }));
        this.logger?.error?.("runtime_trace_failed", traceDetails(trace, {
          totalDurationMs: traceDurationMs(trace, this.clock()),
          lastSuccessfulStage: "prompt_send",
          reason: "completion_monitor_failed",
          protocolAccepted: false,
          protocolApplied: false,
          planningAdvanced: false
        }));
        return { ok: false, reason: "completion_monitor_failed", message: String(error?.message || error) };
      })
      .finally(() => {
        if (this.active.get(id)?.token === control.token) this.active.delete(id);
      });
    this.active.set(id, control);
    return { ok: true, agentId: id, sessionId: control.sessionId, token: control.token, trace };
  }

  async run(runtime, agentId, prepared, control) {
    const trace = normalizeTraceContext(control.trace || prepared.trace, {
      agentId,
      sessionId: control.sessionId
    });
    const baseline = this.normalizeSnapshot(prepared.baseline || {});
    const requiredStablePolls = 1 + Math.ceil(this.quietMs / this.pollMs);
    const maxPolls = 1 + Math.ceil(this.timeoutMs / this.pollMs);
    const monitorStartedAt = this.clock();
    let stableFingerprint = "";
    let stablePolls = 0;
    let candidateFingerprint = "";
    let sawGenerating = false;
    let generationStoppedLogged = false;
    let sawChange = false;
    let changeLogged = false;
    let snapshotErrors = 0;
    let snapshotErrorElapsedMs = 0;
    let lastSnapshot = baseline;

    const elapsedMs = () => Math.max(0, this.clock() - monitorStartedAt);
    const lastStage = () => (
      sawChange ? "assistant_change"
        : sawGenerating ? "generation_observed"
          : "prompt_send"
    );
    const terminalDetails = (reason, extra = {}) => traceDetails(trace, {
      totalDurationMs: traceDurationMs(trace, this.clock()),
      lastSuccessfulStage: lastStage(),
      reason,
      protocolAccepted: false,
      protocolApplied: false,
      planningAdvanced: false,
      ...extra
    });

    for (let poll = 0; poll < maxPolls; poll += 1) {
      if (control.cancelled || this.closed) {
        const reason = control.cancelReason || "completion_monitor_cancelled";
        this.logger?.warn?.("runtime_trace_cancelled", terminalDetails(reason));
        return { ok: false, cancelled: true, reason };
      }

      const currentAgent = runtime?.getAgent?.(agentId) || null;
      const currentSessionId = runtime?.sessionIdForAgent?.(currentAgent);
      if (!currentAgent || String(currentSessionId || "") !== control.sessionId) {
        const reason = "completion_monitor_session_changed";
        this.logger?.warn?.("runtime_trace_cancelled", terminalDetails(reason));
        return { ok: false, cancelled: true, reason };
      }

      const raw = await this.driver.readAssistantSnapshot(control.sessionId, { trace });
      if (!raw?.ok) {
        snapshotErrors += 1;
        const retryDelayMs = Math.min(2000, this.pollMs * Math.pow(2, Math.min(4, snapshotErrors - 1)));
        snapshotErrorElapsedMs += retryDelayMs;
        const reason = raw?.reason || "managed_browser_snapshot_unavailable";
        if (snapshotErrors >= this.maxSnapshotErrors || snapshotErrorElapsedMs >= this.snapshotErrorGraceMs) {
          await this.protocolAdapter.publishProtocolError(runtime, agentId, lastSnapshot, { reason }, trace);
          this.logger?.error?.("runtime_trace_failed", terminalDetails(reason, {
            snapshotErrors,
            snapshotErrorElapsedMs
          }));
          return {
            ok: false,
            reason,
            snapshotErrors,
            snapshotErrorElapsedMs
          };
        }
        this.logger?.debug?.("managed_browser_snapshot_retry", traceDetails(trace, {
          reason,
          snapshotErrors,
          retryDelayMs,
          snapshotErrorElapsedMs
        }));
        await this.sleep(retryDelayMs);
        continue;
      }

      snapshotErrors = 0;
      snapshotErrorElapsedMs = 0;
      const snapshot = this.normalizeSnapshot(raw);
      lastSnapshot = snapshot;
      const generating = snapshot.generating || snapshot.availability === "generating";
      if (generating && !sawGenerating) {
        sawGenerating = true;
        this.logger?.info?.("managed_browser_generation_started", traceDetails(trace, {
          pollIndex: poll,
          elapsedMs: elapsedMs(),
          ...snapshotMetadata(snapshot)
        }));
      } else if (!generating && sawGenerating && !generationStoppedLogged) {
        generationStoppedLogged = true;
        this.logger?.info?.("managed_browser_generation_stopped", traceDetails(trace, {
          pollIndex: poll,
          elapsedMs: elapsedMs(),
          ...snapshotMetadata(snapshot)
        }));
      }

      const fingerprintChanged = Boolean(snapshot.fingerprint && snapshot.fingerprint !== baseline.fingerprint);
      const messageAdvanced = snapshot.messageCount > baseline.messageCount;
      if (fingerprintChanged || messageAdvanced) {
        sawChange = true;
        if (!changeLogged) {
          changeLogged = true;
          this.logger?.info?.("managed_browser_assistant_change_detected", traceDetails(trace, {
            pollIndex: poll,
            elapsedMs: elapsedMs(),
            baselineMessageCount: baseline.messageCount,
            currentMessageCount: snapshot.messageCount,
            fingerprintChanged,
            messageAdvanced,
            availability: snapshot.availability,
            generating: snapshot.generating,
            responseFingerprint: snapshot.fingerprint || ""
          }));
        }
      }

      const candidate = sawChange
        && !snapshot.generating
        && snapshot.availability === "ready"
        && Boolean(snapshot.text.trim())
        && Boolean(snapshot.fingerprint);

      if (candidate) {
        if (stableFingerprint === snapshot.fingerprint) stablePolls += 1;
        else {
          stableFingerprint = snapshot.fingerprint;
          stablePolls = 1;
        }
        if (candidateFingerprint !== snapshot.fingerprint) {
          candidateFingerprint = snapshot.fingerprint;
          this.logger?.info?.("managed_browser_completion_candidate", traceDetails(trace, {
            elapsedMs: elapsedMs(),
            baselineMessageCount: baseline.messageCount,
            currentMessageCount: snapshot.messageCount,
            fingerprintChanged,
            stablePollCount: stablePolls,
            requiredStablePolls,
            responseBytes: byteLength(snapshot.text),
            responseFingerprint: snapshot.fingerprint,
            availability: snapshot.availability,
            generating: snapshot.generating
          }));
        }
        if (stablePolls >= requiredStablePolls) {
          this.logger?.info?.("managed_browser_completion_stable", traceDetails(trace, {
            elapsedMs: elapsedMs(),
            baselineMessageCount: baseline.messageCount,
            currentMessageCount: snapshot.messageCount,
            fingerprintChanged,
            stablePollCount: stablePolls,
            responseBytes: byteLength(snapshot.text),
            responseFingerprint: snapshot.fingerprint,
            availability: snapshot.availability,
            generating: snapshot.generating
          }));
          const published = await this.protocolAdapter.publishCompletion(runtime, agentId, snapshot, trace);
          const eventResult = published?.eventResult || {};
          const parsedEvent = published?.parsed?.event || null;
          const planningExpected = parsedEvent?.event === "DONE" && String(parsedEvent?.taskId || "").startsWith("planning:");
          let traceSucceeded = Boolean(published?.ok);
          let terminalReason = published?.reason || null;
          if (traceSucceeded && planningExpected && !eventResult?.planningConsumed) {
            traceSucceeded = false;
            terminalReason = "planning_completion_not_consumed";
          } else if (traceSucceeded && planningExpected && !eventResult?.planningAdvanced) {
            traceSucceeded = false;
            terminalReason = eventResult?.planningReason || "planning_not_advanced";
          }
          const common = {
            totalDurationMs: traceDurationMs(trace, this.clock()),
            lastSuccessfulStage: eventResult?.planningAdvanced
              ? "planning_advanced"
              : eventResult?.planningConsumed
                ? "planning_consumed"
                : eventResult?.applied
                  ? "event_applied"
                  : published?.parsed?.kind === "orchestra_event"
                    ? "protocol_parsed"
                    : "completion_stable",
            reason: terminalReason,
            protocolAccepted: Boolean(eventResult?.accepted || eventResult?.duplicate),
            protocolApplied: Boolean(eventResult?.applied),
            planningConsumed: Boolean(eventResult?.planningConsumed),
            planningAdvanced: Boolean(eventResult?.planningAdvanced),
            planningReason: eventResult?.planningReason || null,
            eventId: eventResult?.eventId || parsedEvent?.eventId || null
          };
          if (traceSucceeded) this.logger?.info?.("runtime_trace_completed", traceDetails(trace, common));
          else this.logger?.error?.("runtime_trace_failed", traceDetails(trace, common));
          return {
            ok: Boolean(published?.ok),
            reason: published?.reason || null,
            published,
            sawGenerating,
            snapshot
          };
        }
      } else {
        stableFingerprint = "";
        stablePolls = 0;
        candidateFingerprint = "";
      }

      if (poll + 1 < maxPolls) await this.sleep(this.pollMs);
    }

    await this.protocolAdapter.publishProtocolError(runtime, agentId, lastSnapshot, {
      reason: "managed_browser_completion_timeout"
    }, trace);
    this.logger?.warn?.("runtime_trace_timed_out", terminalDetails("managed_browser_completion_timeout"));
    return { ok: false, reason: "managed_browser_completion_timeout", sawGenerating };
  }

  waitFor(agentId) {
    return this.active.get(String(agentId || ""))?.promise || null;
  }

  cancel(agentId, reason = "completion_monitor_cancelled") {
    const control = this.active.get(String(agentId || ""));
    if (!control) return false;
    control.cancelled = true;
    control.cancelReason = String(reason || "completion_monitor_cancelled");
    return true;
  }

  cancelSession(sessionId, reason = "completion_monitor_session_cancelled") {
    const normalized = String(sessionId || "");
    let cancelled = 0;
    for (const control of this.active.values()) {
      if (control.sessionId !== normalized) continue;
      control.cancelled = true;
      control.cancelReason = String(reason || "completion_monitor_session_cancelled");
      cancelled += 1;
    }
    return cancelled;
  }

  close() {
    this.closed = true;
    for (const control of this.active.values()) {
      control.cancelled = true;
      control.cancelReason = "completion_monitor_closed";
    }
  }
}

module.exports = { ManagedBrowserCompletionMonitor, RETRYABLE_PREPARE_REASONS };
