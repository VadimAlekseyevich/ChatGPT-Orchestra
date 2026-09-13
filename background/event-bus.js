(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};
  const Protocol = root.OrchestraProtocol
    || (typeof require === "function" ? require("../protocol/orchestra-protocol.js") : null);
  const StoreModule = typeof require === "function" ? require("./event-store.js") : null;
  const eventSignature = root.eventSignature || StoreModule?.eventSignature;

  class EventBus {
    constructor({ registry, store, logger = console } = {}) {
      this.registry = registry;
      this.store = store;
      this.logger = logger;
      this.listeners = new Map();
    }

    async load() { return this.store.load(); }
    summary() { return this.store.summary(); }
    recent(limit) {
      return {
        events: this.store.recentEvents(limit),
        rejections: this.store.recentRejections(Math.min(25, Number(limit) || 25))
      };
    }

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
      for (const listener of listeners) {
        try {
          await listener(record);
        } catch (error) {
          this.logger.warn?.("[ChatGPT Orchestra] event_listener_failed", route, error?.message || String(error));
        }
      }
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
      // Temporary compatibility for Phase 3-9 tests/older callers. Extension runtime
      // normalizes senders before EventBus in production Phase 10 composition.
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

    async reject(reason, { event = null, sender = null, details = null } = {}) {
      const context = this.normalizeSender(sender || {});
      await this.store.reject(reason, {
        event,
        tabId: context.legacyTabId,
        runtimeSource: { kind: context.kind, sessionId: context.sessionId, agentId: context.agentId },
        details
      });
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

    async handleEvent(rawEvent, sender, source = {}) {
      const validation = Protocol.validateEnvelope(rawEvent);
      if (!validation.ok) {
        return this.reject(validation.reason, {
          sender,
          details: { field: validation.field || null, received: validation.received ?? null }
        });
      }
      const event = validation.event;
      const context = this.normalizeSender(sender || {});
      if (!context.agentId) return this.reject(context.sessionId ? "unregistered_sender" : "missing_sender_identity", { event, sender: context });

      const agent = this.registry.getAgent(context.agentId);
      if (!agent) return this.reject("unregistered_sender", { event, sender: context });
      if (event.agentId !== agent.agentId) {
        return this.reject("agent_mismatch", { event, sender: context, details: { expectedAgentId: agent.agentId } });
      }

      const route = Protocol.routeForEvent(event.event);
      if (!route) return this.reject("unknown_route", { event, sender: context });

      const protocolContext = this.validateProtocolContext(agent, event);
      if (!protocolContext.ok) {
        return this.reject(protocolContext.reason, {
          event,
          sender: context,
          details: { field: protocolContext.field, expected: protocolContext.expected, received: protocolContext.received }
        });
      }
      const privileged = route === "review" || route === "integration" || event.taskId === "integration";
      if (privileged && !agent.protocolContext) {
        return this.reject(route === "review" ? "review_context_required" : "integration_context_required", { event, sender: context });
      }

      const existing = this.store.getProcessed(event.eventId);
      if (existing) {
        if (existing.signature && existing.signature === eventSignature(event)) {
          return { ok: true, duplicate: true, eventId: event.eventId, cursor: existing.cursor, route };
        }
        return this.reject("event_id_collision", { event, sender: context });
      }

      const runKey = `${event.projectId}:${event.taskId}:${event.runId}:${event.agentId}`;
      const lastSequence = this.store.getLastSequence(runKey);
      if (event.sequence <= lastSequence) {
        return this.reject("stale_sequence", { event, sender: context, details: { lastSequence } });
      }

      const runtimeSource = { kind: context.kind, sessionId: context.sessionId, agentId: context.agentId };
      const accepted = await this.store.accept(event, {
        route,
        tabId: context.legacyTabId,
        runtimeSource,
        source: { ...source, runtime: runtimeSource }
      });
      const record = {
        cursor: accepted.cursor,
        route,
        tabId: context.legacyTabId,
        runtimeSource,
        source: accepted.source,
        agent,
        event
      };
      await this.emit(route, record);
      return { ok: true, accepted: true, duplicate: false, cursor: accepted.cursor, route, eventId: event.eventId };
    }

    async handleProtocolError(payload, sender) {
      const context = this.normalizeSender(sender || {});
      if (!context.agentId) return context.sessionId
        ? { ok: true, ignored: true, reason: "unregistered_sender" }
        : { ok: false, reason: "missing_sender_identity" };
      const agent = this.registry.getAgent(context.agentId);
      if (!agent) return { ok: true, ignored: true, reason: "unregistered_sender" };

      const reason = `content_protocol_error:${String(payload?.reason || "unknown")}`;
      await this.store.reject(reason, {
        tabId: context.legacyTabId,
        runtimeSource: { kind: context.kind, sessionId: context.sessionId, agentId: context.agentId },
        details: {
          agentId: agent.agentId,
          lastLine: String(payload?.lastLine || "").slice(0, 512),
          field: payload?.field || null,
          received: payload?.received ?? null,
          responseFingerprint: payload?.responseFingerprint || ""
        }
      });
      return { ok: false, reason };
    }
  }

  root.EventBus = EventBus;
  if (typeof module !== "undefined" && module.exports) module.exports = { EventBus };
})();
