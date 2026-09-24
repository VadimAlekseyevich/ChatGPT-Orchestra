(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};
  const Protocol = root.OrchestraProtocol
    || (typeof require === "function" ? require("../protocol/orchestra-protocol.js") : null);
  const StoreModule = typeof require === "function" ? require("./event-store.js") : null;
  const eventSignature = root.eventSignature || StoreModule?.eventSignature;
  const TRACE_FIELDS = ["traceId", "projectId", "taskId", "runId", "agentId", "stage", "sessionId", "dispatchKind", "startedAt"];

  function traceContext(value = null, fallback = {}) {
    const source = value?.trace && typeof value.trace === "object" ? value.trace : (value && typeof value === "object" ? value : {});
    const base = fallback?.trace && typeof fallback.trace === "object" ? fallback.trace : (fallback && typeof fallback === "object" ? fallback : {});
    const merged = { ...base, ...source };
    const trace = {};
    for (const field of TRACE_FIELDS) {
      if (field === "startedAt") {
        const numeric = Number(merged[field]);
        if (Number.isFinite(numeric) && numeric > 0) trace[field] = numeric;
        continue;
      }
      const text = merged[field] === null || merged[field] === undefined ? "" : String(merged[field]);
      if (text) trace[field] = text;
    }
    return trace;
  }

  function traced(trace, details = {}) {
    return { ...traceContext(trace), ...(details && typeof details === "object" ? details : { value: details }) };
  }

  class EventBus {
    constructor({ registry, store, logger = console } = {}) {
      this.registry = registry;
      this.store = store;
      this.logger = logger;
      this.listeners = new Map();
      this.inFlight = new Map();
    }

    async load() { return this.store.load(); }
    summary() { return this.store.summary(); }
    recent(limit) {
      return {
        events: this.store.recentEvents(limit),
        rejections: this.store.recentRejections(Math.min(25, Number(limit) || 25))
      };
    }
    allEvents() { return this.store.allEvents?.() || this.store.recentEvents?.(200) || []; }

    subscribe(route, listener) {
      if (typeof listener !== "function") return () => {};
      const key = String(route || "*");
      const listeners = this.listeners.get(key) || new Set();
      listeners.add(listener);
      this.listeners.set(key, listeners);
      return () => {
        listeners.delete(listener);
        if (!listeners.size) this.listeners.delete(key);
      };
    }

    async emit(route, record) {
      const listeners = [...(this.listeners.get(route) || []), ...(this.listeners.get("*") || [])];
      if (!listeners.length) return {
        ok: false,
        reason: "event_listener_missing",
        delivered: 0,
        errors: [],
        planningConsumed: false,
        planningAdvanced: false
      };
      const errors = [];
      let delivered = 0;
      let planningConsumed = false;
      let planningAdvanced = false;
      for (const listener of listeners) {
        try {
          const result = await listener(record);
          delivered += 1;
          if (result?.planningConsumed === true) planningConsumed = true;
          if (result?.planningAdvanced === true) planningAdvanced = true;
        } catch (error) {
          const message = error?.message || String(error);
          errors.push(message);
          this.logger.warn?.("[ChatGPT Orchestra] event_listener_failed", route, message);
        }
      }
      return errors.length
        ? { ok: false, reason: "event_listener_failed", delivered, errors, planningConsumed, planningAdvanced }
        : { ok: true, delivered, errors: [], planningConsumed, planningAdvanced };
    }

    normalizeSender(sender = {}) {
      if (sender?.agentId || sender?.sessionId || sender?.kind) {
        return {
          kind: String(sender.kind || "agent-session"),
          sessionId: sender.sessionId === null || sender.sessionId === undefined ? null : String(sender.sessionId),
          agentId: sender.agentId ? String(sender.agentId) : null,
          url: String(sender.url || ""),
          legacyTabId: Number.isInteger(sender.legacyTabId) ? sender.legacyTabId : null
        };
      }
      const tabId = sender?.tab?.id;
      const agent = Number.isInteger(tabId) ? this.registry?.getAgentByTabId?.(tabId) : null;
      return {
        kind: Number.isInteger(tabId) ? "legacy-extension-tab" : "unknown",
        sessionId: Number.isInteger(tabId) ? String(tabId) : null,
        agentId: agent?.agentId || null,
        url: String(sender?.tab?.url || agent?.chatUrl || ""),
        legacyTabId: Number.isInteger(tabId) ? tabId : null
      };
    }

    async reject(reason, { event = null, sender = null, details = null, trace = null, route = null } = {}) {
      const context = this.normalizeSender(sender || {});
      const normalizedTrace = traceContext(trace, {
        projectId: event?.projectId,
        taskId: event?.taskId,
        runId: event?.runId,
        agentId: event?.agentId || context.agentId,
        sessionId: context.sessionId
      });
      await this.store.reject(reason, {
        event,
        tabId: context.legacyTabId,
        runtimeSource: { kind: context.kind, sessionId: context.sessionId, agentId: context.agentId },
        details: { ...(details || {}), trace: normalizedTrace }
      });
      this.logger?.warn?.("orchestra_event_rejected", traced(normalizedTrace, {
        eventId: event?.eventId || null,
        route: route || (event ? Protocol.routeForEvent(event.event) : null),
        reason,
        cursor: details?.cursor ?? null,
        duplicate: false,
        replayed: false
      }));
      return { ok: false, reason };
    }

    validateProtocolContext(agent, event) {
      const expected = agent?.protocolContext;
      if (!expected) return { ok: true };
      for (const field of ["projectId", "taskId", "runId"]) {
        if (expected[field] && event[field] !== expected[field]) {
          return { ok: false, reason: `${field}_mismatch`, field, expected: expected[field], received: event[field] };
        }
      }
      return { ok: true };
    }

    recordFromStored(stored) {
      if (!stored?.event) return null;
      const context = stored.runtimeSource || stored.source?.runtime || {};
      const agent = stored.event.agentId ? this.registry?.getAgent?.(stored.event.agentId) : null;
      return {
        cursor: stored.cursor,
        route: stored.route || Protocol.routeForEvent(stored.event.event),
        tabId: Number.isInteger(stored.tabId) ? stored.tabId : null,
        runtimeSource: context,
        source: stored.source || {},
        agent,
        event: stored.event
      };
    }

    recordTrace(record) {
      return traceContext(record?.source?.trace || record?.agent?.protocolContext, {
        projectId: record?.event?.projectId,
        taskId: record?.event?.taskId,
        runId: record?.event?.runId,
        agentId: record?.event?.agentId || record?.runtimeSource?.agentId,
        sessionId: record?.runtimeSource?.sessionId
      });
    }

    async applyRecord(record, { replayed = false } = {}) {
      const eventId = record?.event?.eventId;
      if (!eventId) return { ok: false, reason: "event_id_missing" };
      const trace = this.recordTrace(record);
      const execute = async () => {
        this.logger?.info?.("orchestra_event_apply_started", traced(trace, {
          eventId,
          route: record.route,
          cursor: record.cursor ?? null,
          replayed
        }));
        const delivered = await this.emit(record.route, record);
        if (!delivered.ok) {
          await this.store.markDeliveryFailed?.(eventId, delivered.errors?.[0] || delivered.reason);
          this.logger?.error?.("orchestra_event_apply_failed", traced(trace, {
            eventId,
            route: record.route,
            cursor: record.cursor ?? null,
            replayed,
            reason: delivered.reason || "event_listener_failed",
            delivered: delivered.delivered || 0,
            planningConsumed: Boolean(delivered.planningConsumed),
            planningAdvanced: Boolean(delivered.planningAdvanced)
          }));
          return {
            ok: false,
            reason: delivered.reason || "event_listener_failed",
            eventId,
            cursor: record.cursor,
            route: record.route,
            replayed,
            delivered: delivered.delivered || 0,
            errors: delivered.errors || [],
            planningConsumed: Boolean(delivered.planningConsumed),
            planningAdvanced: Boolean(delivered.planningAdvanced)
          };
        }
        await this.store.markApplied?.(eventId);
        this.logger?.info?.("orchestra_event_applied", traced(trace, {
          eventId,
          route: record.route,
          cursor: record.cursor ?? null,
          replayed,
          delivered: delivered.delivered || 0,
          planningConsumed: Boolean(delivered.planningConsumed),
          planningAdvanced: Boolean(delivered.planningAdvanced)
        }));
        return {
          ok: true,
          applied: true,
          eventId,
          cursor: record.cursor,
          route: record.route,
          replayed,
          delivered: delivered.delivered || 0,
          planningConsumed: Boolean(delivered.planningConsumed),
          planningAdvanced: Boolean(delivered.planningAdvanced)
        };
      };
      const existing = this.inFlight.get(eventId);
      if (existing) return existing;
      const promise = execute().finally(() => {
        if (this.inFlight.get(eventId) === promise) this.inFlight.delete(eventId);
      });
      this.inFlight.set(eventId, promise);
      return promise;
    }

    async replayPending({ limit = 1000 } = {}) {
      const records = this.store.pendingEvents?.(limit) || [];
      const results = [];
      for (const stored of records) {
        const record = this.recordFromStored(stored);
        if (!record?.route) {
          results.push({ ok: false, reason: "unknown_route", eventId: stored?.event?.eventId || null });
          continue;
        }
        results.push(await this.applyRecord(record, { replayed: true }));
      }
      return {
        ok: results.every((item) => item?.ok),
        attempted: results.length,
        applied: results.filter((item) => item?.ok).length,
        failed: results.filter((item) => !item?.ok).length,
        results
      };
    }

    async handleEvent(rawEvent, sender, source = {}) {
      const sourceTrace = traceContext(source?.trace);
      const validation = Protocol.validateEnvelope(rawEvent);
      if (!validation.ok) {
        return this.reject(validation.reason, {
          sender,
          trace: sourceTrace,
          details: { field: validation.field || null, received: validation.received ?? null }
        });
      }
      const event = validation.event;
      const context = this.normalizeSender(sender || {});
      if (!context.agentId) {
        return this.reject(context.sessionId ? "unregistered_sender" : "missing_sender_identity", {
          event,
          sender: context,
          trace: sourceTrace
        });
      }

      const agent = this.registry.getAgent(context.agentId);
      const trace = traceContext(sourceTrace, {
        ...(agent?.protocolContext || {}),
        projectId: event.projectId,
        taskId: event.taskId,
        runId: event.runId,
        agentId: event.agentId,
        sessionId: context.sessionId
      });
      if (!agent) return this.reject("unregistered_sender", { event, sender: context, trace });
      if (event.agentId !== agent.agentId) {
        return this.reject("agent_mismatch", {
          event,
          sender: context,
          trace,
          details: { expectedAgentId: agent.agentId }
        });
      }

      const route = Protocol.routeForEvent(event.event);
      if (!route) return this.reject("unknown_route", { event, sender: context, trace });

      const protocolContext = this.validateProtocolContext(agent, event);
      if (!protocolContext.ok) {
        return this.reject(protocolContext.reason, {
          event,
          sender: context,
          trace,
          route,
          details: { field: protocolContext.field, expected: protocolContext.expected, received: protocolContext.received }
        });
      }
      const privileged = route === "review" || route === "integration" || event.taskId === "integration";
      if (privileged && !agent.protocolContext) {
        return this.reject(route === "review" ? "review_context_required" : "integration_context_required", {
          event,
          sender: context,
          trace,
          route
        });
      }

      const existing = this.store.getProcessed(event.eventId);
      if (existing) {
        if (!existing.signature || existing.signature !== eventSignature(event)) {
          return this.reject("event_id_collision", { event, sender: context, trace, route });
        }
        if (existing.status === "applied") {
          this.logger?.info?.("orchestra_event_accepted", traced(trace, {
            eventId: event.eventId,
            route,
            cursor: existing.cursor ?? null,
            duplicate: true,
            replayed: true,
            applied: true
          }));
          return {
            ok: true,
            duplicate: true,
            applied: true,
            eventId: event.eventId,
            cursor: existing.cursor,
            route,
            planningConsumed: false,
            planningAdvanced: false
          };
        }
        const stored = this.store.getEvent?.(event.eventId);
        if (!stored) {
          return this.reject("pending_event_record_missing", {
            event,
            sender: context,
            trace,
            route,
            details: { cursor: existing.cursor || null }
          });
        }
        const replayed = await this.applyRecord(this.recordFromStored(stored), { replayed: true });
        return { ...replayed, duplicate: true };
      }

      const runKey = `${event.projectId}:${event.taskId}:${event.runId}:${event.agentId}`;
      const lastSequence = this.store.getLastSequence(runKey);
      if (event.sequence <= lastSequence) {
        return this.reject("stale_sequence", {
          event,
          sender: context,
          trace,
          route,
          details: { lastSequence }
        });
      }

      const runtimeSource = { kind: context.kind, sessionId: context.sessionId, agentId: context.agentId };
      const accepted = await this.store.accept(event, {
        route,
        tabId: context.legacyTabId,
        runtimeSource,
        source: { ...source, trace, runtime: runtimeSource }
      });
      this.logger?.info?.("orchestra_event_accepted", traced(trace, {
        eventId: event.eventId,
        route,
        cursor: accepted.cursor ?? null,
        duplicate: false,
        replayed: false
      }));
      const record = {
        cursor: accepted.cursor,
        route,
        tabId: context.legacyTabId,
        runtimeSource,
        source: accepted.source,
        agent,
        event
      };
      const applied = await this.applyRecord(record);
      return {
        ...applied,
        accepted: true,
        duplicate: false,
        cursor: accepted.cursor,
        route,
        eventId: event.eventId
      };
    }

    async handleProtocolError(payload, sender) {
      const context = this.normalizeSender(sender || {});
      if (!context.agentId) return context.sessionId
        ? { ok: true, ignored: true, reason: "unregistered_sender" }
        : { ok: false, reason: "missing_sender_identity" };
      const agent = this.registry.getAgent(context.agentId);
      if (!agent) return { ok: true, ignored: true, reason: "unregistered_sender" };

      const trace = traceContext(payload?.trace || agent.protocolContext, {
        agentId: agent.agentId,
        sessionId: context.sessionId
      });
      const reason = `content_protocol_error:${String(payload?.reason || "unknown")}`;
      await this.store.reject(reason, {
        tabId: context.legacyTabId,
        runtimeSource: { kind: context.kind, sessionId: context.sessionId, agentId: context.agentId },
        details: {
          agentId: agent.agentId,
          field: payload?.field || null,
          receivedMetadata: payload?.receivedMetadata || null,
          lastLineMetadata: payload?.lastLineMetadata || null,
          responseFingerprint: payload?.responseFingerprint || "",
          trace
        }
      });
      this.logger?.warn?.("orchestra_event_rejected", traced(trace, {
        eventId: null,
        route: "protocol-error",
        cursor: null,
        reason,
        duplicate: false,
        replayed: false
      }));
      return { ok: false, reason };
    }
  }

  root.EventBus = EventBus;
  if (typeof module !== "undefined" && module.exports) module.exports = { EventBus };
})();
