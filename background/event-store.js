(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};
  const STORAGE_KEY = "orchestra.eventBus.v1";
  const SCHEMA_VERSION = 1;
  const DEFAULT_MAX_EVENTS = 1000;
  const DEFAULT_MAX_REJECTIONS = 250;
  const DEFAULT_MAX_PROCESSED = 10000;
  const MAX_PLANNING_ARTIFACT_LENGTH = 262144;
  const MAX_WORKER_ARTIFACT_LENGTH = 192 * 1024;

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
  function normalizeBoundedArtifact(value, maxLength) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    try {
      const encoded = JSON.stringify(value);
      if (encoded.length > maxLength) return null;
      return clone(value);
    } catch (_) { return null; }
  }
  function normalizePlanningArtifact(value) {
    return normalizeBoundedArtifact(value, MAX_PLANNING_ARTIFACT_LENGTH);
  }
  function normalizeWorkerArtifact(value) {
    const artifact = normalizeBoundedArtifact(value, MAX_WORKER_ARTIFACT_LENGTH);
    if (!artifact || String(artifact.format || "") !== "file-set-v1" || !Array.isArray(artifact.files)) return null;
    return artifact;
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
      workerArtifact: normalizeWorkerArtifact(source?.workerArtifact),
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
  function processedStatus(value) {
    if (!value) return null;
    // Entries written before durable delivery tracking existed were effectively
    // considered processed. Keep that interpretation for backwards compatibility;
    // engine-specific recovery can still reconcile old accepted records.
    return value.status === "accepted" || value.status === "applied" ? value.status : "applied";
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
      const pendingEvents = this.state.processedOrder.reduce((count, eventId) => (
        processedStatus(this.state.processedEvents[eventId]) === "accepted" ? count + 1 : count
      ), 0);
      return {
        schemaVersion: this.state.schemaVersion,
        eventCursor: this.state.eventCursor,
        acceptedEvents: this.state.events.length,
        processedEventIds: this.state.processedOrder.length,
        pendingEvents,
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

    getProcessed(eventId) {
      const item = this.state.processedEvents[eventId];
      return item ? { ...clone(item), status: processedStatus(item) } : null;
    }
    getLastSequence(runKey) {
      const value = Number(this.state.sequences[runKey]);
      return Number.isSafeInteger(value) ? value : 0;
    }
    getEvent(eventId) {
      const id = String(eventId || "");
      const record = [...this.state.events].reverse().find((item) => item?.event?.eventId === id);
      return record ? clone(record) : null;
    }
    allEvents() { return clone(this.state.events); }
    pendingEvents(limit = this.maxEvents) {
      const count = Math.max(1, Math.min(this.maxEvents, Number(limit) || this.maxEvents));
      return clone(this.state.events.filter((record) => (
        processedStatus(this.state.processedEvents[record?.event?.eventId]) === "accepted"
      )).slice(0, count));
    }

    pruneProcessed() {
      while (this.state.processedOrder.length > this.maxProcessed) {
        const removableIndex = this.state.processedOrder.findIndex((eventId) => (
          processedStatus(this.state.processedEvents[eventId]) !== "accepted"
        ));
        if (removableIndex < 0) break;
        const [eventId] = this.state.processedOrder.splice(removableIndex, 1);
        if (eventId) delete this.state.processedEvents[eventId];
      }
    }

    pruneEvents() {
      while (this.state.events.length > this.maxEvents) {
        const removableIndex = this.state.events.findIndex((record) => {
          const eventId = record?.event?.eventId;
          return processedStatus(this.state.processedEvents[eventId]) !== "accepted";
        });
        if (removableIndex < 0) break;
        this.state.events.splice(removableIndex, 1);
      }
    }

    async accept(event, { route = null, tabId = null, runtimeSource = null, source = null } = {}) {
      const now = this.clock();
      this.state.eventCursor += 1;
      const cursor = this.state.eventCursor;
      const identity = eventIdentity(event);
      const runKey = `${event.projectId}:${event.taskId}:${event.runId}:${event.agentId}`;
      const normalizedSource = normalizeSource({ ...(source || {}), runtime: source?.runtime || runtimeSource || null });

      this.state.processedEvents[event.eventId] = {
        ...identity,
        signature: eventSignature(event),
        cursor,
        status: "accepted",
        acceptedAt: now,
        appliedAt: null,
        deliveryAttempts: 0,
        lastDeliveryError: null,
        lastDeliveryAttemptAt: null
      };
      this.state.processedOrder.push(event.eventId);
      this.pruneProcessed();

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
      this.pruneEvents();
      await this.persist();
      return { cursor, runKey, source: clone(normalizedSource) };
    }

    async markApplied(eventId) {
      const id = String(eventId || "");
      const item = this.state.processedEvents[id];
      if (!item) return null;
      const now = this.clock();
      item.status = "applied";
      item.appliedAt = item.appliedAt || now;
      item.lastDeliveryAttemptAt = now;
      item.deliveryAttempts = Math.max(1, Number(item.deliveryAttempts) || 0);
      item.lastDeliveryError = null;
      this.pruneProcessed();
      this.pruneEvents();
      await this.persist();
      return this.getProcessed(id);
    }

    async markDeliveryFailed(eventId, error) {
      const id = String(eventId || "");
      const item = this.state.processedEvents[id];
      if (!item) return null;
      item.status = "accepted";
      item.deliveryAttempts = (Number(item.deliveryAttempts) || 0) + 1;
      item.lastDeliveryAttemptAt = this.clock();
      item.lastDeliveryError = String(error?.message || error || "event_listener_failed").slice(0, 1000);
      await this.persist();
      return this.getProcessed(id);
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

    recentEvents(limit = 50) {
      const count = Math.max(1, Math.min(200, Number(limit) || 50));
      return clone(this.state.events.slice(-count));
    }
    recentRejections(limit = 25) {
      const count = Math.max(1, Math.min(100, Number(limit) || 25));
      return clone(this.state.rejections.slice(-count));
    }
  }

  root.EventStore = EventStore;
  root.EVENT_STORE_STORAGE_KEY = STORAGE_KEY;
  root.eventSignature = eventSignature;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      EventStore,
      STORAGE_KEY,
      SCHEMA_VERSION,
      eventIdentity,
      eventSignature,
      canonicalize,
      normalizeSource,
      normalizePlanningArtifact,
      normalizeWorkerArtifact,
      normalizeRuntimeSource,
      processedStatus,
      MAX_WORKER_ARTIFACT_LENGTH
    };
  }
})();
