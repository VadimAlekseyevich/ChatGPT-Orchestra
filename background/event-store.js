(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};
  const STORAGE_KEY = "orchestra.eventBus.v1";
  const SCHEMA_VERSION = 1;
  const DEFAULT_MAX_EVENTS = 1000;
  const DEFAULT_MAX_REJECTIONS = 250;
  const DEFAULT_MAX_PROCESSED = 10000;
  const MAX_PLANNING_ARTIFACT_LENGTH = 262144;

  function clone(value) {
    if (typeof structuredClone === "function") return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }
  function canonicalize(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
    if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
    return JSON.stringify(value);
  }
  function eventSignature(event) {
    return canonicalize({
      v: event.v,
      event: event.event,
      projectId: event.projectId,
      taskId: event.taskId,
      runId: event.runId,
      agentId: event.agentId,
      eventId: event.eventId,
      sequence: event.sequence,
      payload: event.payload || {}
    });
  }
  function normalizePlanningArtifact(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    try {
      const encoded = JSON.stringify(value);
      if (encoded.length > MAX_PLANNING_ARTIFACT_LENGTH) return null;
      return clone(value);
    } catch (_) { return null; }
  }
  function normalizeRuntimeSource(value) {
    if (!value || typeof value !== "object") return null;
    const kind = String(value.kind || "").slice(0, 80);
    const sessionId = value.sessionId === null || value.sessionId === undefined ? null : String(value.sessionId).slice(0, 256);
    const agentId = value.agentId ? String(value.agentId).slice(0, 256) : null;
    return kind || sessionId || agentId ? { kind: kind || "unknown", sessionId, agentId } : null;
  }
  function normalizeSource(source = {}) {
    return {
      responseFingerprint: String(source?.responseFingerprint || "").slice(0, 256),
      pathname: String(source?.pathname || "").slice(0, 1024),
      messageCount: Math.max(0, Number(source?.messageCount) || 0),
      planningArtifact: normalizePlanningArtifact(source?.planningArtifact),
      runtime: normalizeRuntimeSource(source?.runtime)
    };
  }
  function defaultState() {
    return {
      schemaVersion: SCHEMA_VERSION,
      eventCursor: 0,
      processedEvents: {},
      processedOrder: [],
      sequences: {},
      events: [],
      rejections: [],
      updatedAt: 0
    };
  }
  function eventIdentity(event) {
    return {
      event: event.event,
      projectId: event.projectId,
      taskId: event.taskId,
      runId: event.runId,
      agentId: event.agentId,
      sequence: event.sequence
    };
  }

  class EventStore {
    constructor({ stateStore = null, storageArea = null, clock = () => Date.now(), maxEvents = DEFAULT_MAX_EVENTS, maxRejections = DEFAULT_MAX_REJECTIONS, maxProcessed = DEFAULT_MAX_PROCESSED } = {}) {
      this.stateStore = stateStore || storageArea || null;
      this.clock = clock;
      this.maxEvents = Math.max(100, Number(maxEvents) || DEFAULT_MAX_EVENTS);
      this.maxRejections = Math.max(50, Number(maxRejections) || DEFAULT_MAX_REJECTIONS);
      this.maxProcessed = Math.max(1000, Number(maxProcessed) || DEFAULT_MAX_PROCESSED);
      this.state = defaultState();
      this.loaded = false;
      this.writeChain = Promise.resolve();
    }

    async load() {
      if (!this.stateStore?.get) { this.loaded = true; return this.snapshot(); }
      const stored = await this.stateStore.get(STORAGE_KEY);
      const candidate = stored?.[STORAGE_KEY];
      if (candidate?.schemaVersion === SCHEMA_VERSION) {
        this.state = {
          ...defaultState(),
          ...candidate,
          processedEvents: { ...(candidate.processedEvents || {}) },
          processedOrder: Array.isArray(candidate.processedOrder) ? [...candidate.processedOrder] : [],
          sequences: { ...(candidate.sequences || {}) },
          events: Array.isArray(candidate.events) ? [...candidate.events] : [],
          rejections: Array.isArray(candidate.rejections) ? [...candidate.rejections] : []
        };
      }
      this.loaded = true;
      return this.snapshot();
    }

    snapshot() { return clone(this.state); }
    summary() {
      return {
        schemaVersion: this.state.schemaVersion,
        eventCursor: this.state.eventCursor,
        acceptedEvents: this.state.events.length,
        processedEventIds: this.state.processedOrder.length,
        rejectedEvents: this.state.rejections.length,
        updatedAt: this.state.updatedAt
      };
    }

    async persist() {
      this.state.updatedAt = this.clock();
      if (!this.stateStore?.set) return this.snapshot();
      const payload = clone(this.state);
      this.writeChain = this.writeChain.catch(() => {}).then(() => this.stateStore.set({ [STORAGE_KEY]: payload }));
      await this.writeChain;
      return this.snapshot();
    }

    getProcessed(eventId) { const item = this.state.processedEvents[eventId]; return item ? clone(item) : null; }
    getLastSequence(runKey) { const value = Number(this.state.sequences[runKey]); return Number.isSafeInteger(value) ? value : 0; }

    async accept(event, { route = null, tabId = null, runtimeSource = null, source = null } = {}) {
      const now = this.clock();
      this.state.eventCursor += 1;
      const cursor = this.state.eventCursor;
      const identity = eventIdentity(event);
      const runKey = `${event.projectId}:${event.taskId}:${event.runId}:${event.agentId}`;
      const normalizedSource = normalizeSource({ ...(source || {}), runtime: source?.runtime || runtimeSource || null });

      this.state.processedEvents[event.eventId] = { ...identity, signature: eventSignature(event), cursor, acceptedAt: now };
      this.state.processedOrder.push(event.eventId);
      while (this.state.processedOrder.length > this.maxProcessed) {
        const oldestId = this.state.processedOrder.shift();
        if (oldestId) delete this.state.processedEvents[oldestId];
      }

      this.state.sequences[runKey] = event.sequence;
      this.state.events.push({
        cursor,
        receivedAt: now,
        route,
        tabId: Number.isInteger(tabId) ? tabId : null,
        runtimeSource: normalizeRuntimeSource(runtimeSource),
        source: normalizedSource,
        event: clone(event)
      });
      if (this.state.events.length > this.maxEvents) this.state.events.splice(0, this.state.events.length - this.maxEvents);
      await this.persist();
      return { cursor, runKey, source: clone(normalizedSource) };
    }

    async reject(reason, { event = null, tabId = null, runtimeSource = null, details = null } = {}) {
      this.state.rejections.push({
        rejectedAt: this.clock(),
        reason: String(reason || "unknown_rejection"),
        tabId: Number.isInteger(tabId) ? tabId : null,
        runtimeSource: normalizeRuntimeSource(runtimeSource),
        identity: event ? eventIdentity(event) : null,
        eventId: event?.eventId || null,
        details: details && typeof details === "object" ? clone(details) : null
      });
      if (this.state.rejections.length > this.maxRejections) this.state.rejections.splice(0, this.state.rejections.length - this.maxRejections);
      await this.persist();
      return { ok: false, reason };
    }

    recentEvents(limit = 50) { const count = Math.max(1, Math.min(200, Number(limit) || 50)); return clone(this.state.events.slice(-count)); }
    recentRejections(limit = 25) { const count = Math.max(1, Math.min(100, Number(limit) || 25)); return clone(this.state.rejections.slice(-count)); }
  }

  root.EventStore = EventStore;
  root.EVENT_STORE_STORAGE_KEY = STORAGE_KEY;
  root.eventSignature = eventSignature;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { EventStore, STORAGE_KEY, SCHEMA_VERSION, eventIdentity, eventSignature, canonicalize, normalizeSource, normalizePlanningArtifact, normalizeRuntimeSource };
  }
})();
