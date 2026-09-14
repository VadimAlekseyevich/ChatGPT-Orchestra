"use strict";

class ManagedBrowserCompletionMonitor {
  constructor({
    driver,
    protocolAdapter,
    pollMs = 400,
    quietMs = 1200,
    timeoutMs = 30 * 60 * 1000,
    maxSnapshotErrors = 3,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
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
    this.maxSnapshotErrors = Math.max(1, Math.min(10, Number(maxSnapshotErrors) || 3));
    this.sleep = sleep;
    this.logger = logger;
    this.active = new Map();
    this.closed = false;
    this.nextToken = 1;
  }

  async prepare(runtime, agentId) {
    if (this.closed) return { ok: false, reason: "completion_monitor_closed" };
    const agent = runtime?.getAgent?.(agentId) || null;
    if (!agent) return { ok: false, reason: "completion_monitor_agent_missing", agentId: String(agentId || "") };
    const sessionId = runtime?.sessionIdForAgent?.(agent);
    if (!sessionId) return { ok: false, reason: "completion_monitor_agent_offline", agentId: agent.agentId };
    const baseline = await this.driver.readAssistantSnapshot(sessionId);
    if (!baseline?.ok) {
      return {
        ok: false,
        reason: baseline?.reason || "completion_monitor_baseline_unavailable",
        agentId: agent.agentId,
        sessionId
      };
    }
    return {
      ok: true,
      agentId: agent.agentId,
      sessionId: String(sessionId),
      baseline: this.normalizeSnapshot(baseline)
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
    const control = {
      token: this.nextToken++,
      agentId: id,
      sessionId: String(prepared.sessionId || ""),
      cancelled: false,
      cancelReason: null,
      promise: null
    };
    control.promise = this.run(runtime, id, prepared, control)
      .catch((error) => {
        this.logger?.warn?.("managed_browser_completion_monitor_failed", {
          agentId: id,
          message: String(error?.message || error)
        });
        return { ok: false, reason: "completion_monitor_failed", message: String(error?.message || error) };
      })
      .finally(() => {
        if (this.active.get(id)?.token === control.token) this.active.delete(id);
      });
    this.active.set(id, control);
    return { ok: true, agentId: id, sessionId: control.sessionId, token: control.token };
  }

  async run(runtime, agentId, prepared, control) {
    const baseline = this.normalizeSnapshot(prepared.baseline || {});
    const requiredStablePolls = 1 + Math.ceil(this.quietMs / this.pollMs);
    const maxPolls = 1 + Math.ceil(this.timeoutMs / this.pollMs);
    let stableFingerprint = "";
    let stablePolls = 0;
    let sawGenerating = false;
    let sawChange = false;
    let snapshotErrors = 0;
    let lastSnapshot = baseline;

    for (let poll = 0; poll < maxPolls; poll += 1) {
      if (control.cancelled || this.closed) {
        return { ok: false, cancelled: true, reason: control.cancelReason || "completion_monitor_cancelled" };
      }

      const currentAgent = runtime?.getAgent?.(agentId) || null;
      const currentSessionId = runtime?.sessionIdForAgent?.(currentAgent);
      if (!currentAgent || String(currentSessionId || "") !== control.sessionId) {
        return { ok: false, cancelled: true, reason: "completion_monitor_session_changed" };
      }

      const raw = await this.driver.readAssistantSnapshot(control.sessionId);
      if (!raw?.ok) {
        snapshotErrors += 1;
        if (snapshotErrors >= this.maxSnapshotErrors) {
          await this.protocolAdapter.publishProtocolError(runtime, agentId, lastSnapshot, {
            reason: raw?.reason || "managed_browser_snapshot_unavailable"
          });
          return { ok: false, reason: raw?.reason || "managed_browser_snapshot_unavailable" };
        }
        await this.sleep(this.pollMs);
        continue;
      }

      snapshotErrors = 0;
      const snapshot = this.normalizeSnapshot(raw);
      lastSnapshot = snapshot;
      if (snapshot.generating || snapshot.availability === "generating") sawGenerating = true;

      const fingerprintChanged = Boolean(snapshot.fingerprint && snapshot.fingerprint !== baseline.fingerprint);
      const messageAdvanced = snapshot.messageCount > baseline.messageCount;
      if (fingerprintChanged || messageAdvanced) sawChange = true;

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
        if (stablePolls >= requiredStablePolls) {
          const published = await this.protocolAdapter.publishCompletion(runtime, agentId, snapshot);
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
      }

      if (poll + 1 < maxPolls) await this.sleep(this.pollMs);
    }

    await this.protocolAdapter.publishProtocolError(runtime, agentId, lastSnapshot, {
      reason: "managed_browser_completion_timeout"
    });
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

module.exports = { ManagedBrowserCompletionMonitor };
