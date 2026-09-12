(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};
  const VERSION = 1;
  const PREFIX = "@@ORCH";
  const MAX_ENVELOPE_LENGTH = 4096;
  const MAX_ID_LENGTH = 160;

  const EVENT_TYPES = Object.freeze([
    "READY",
    "TASK_ACCEPTED",
    "PROGRESS",
    "DONE",
    "BLOCKED",
    "ERROR",
    "REVIEW_APPROVED",
    "CHANGES_REQUIRED",
    "CONFLICT",
    "CONFLICT_RESOLVED",
    "NEEDS_USER",
    "HEARTBEAT"
  ]);
  const EVENT_TYPE_SET = new Set(EVENT_TYPES);

  const ROUTES = Object.freeze({
    READY: "lifecycle",
    TASK_ACCEPTED: "lifecycle",
    PROGRESS: "progress",
    DONE: "completion",
    BLOCKED: "blocker",
    ERROR: "blocker",
    REVIEW_APPROVED: "review",
    CHANGES_REQUIRED: "review",
    CONFLICT: "integration",
    CONFLICT_RESOLVED: "integration",
    NEEDS_USER: "user",
    HEARTBEAT: "lifecycle"
  });

  function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function readString(value, maxLength = MAX_ID_LENGTH) {
    const text = String(value ?? "").trim();
    if (!text || text.length > maxLength) return null;
    return text;
  }

  function normalizeEnvelope(input) {
    if (!isPlainObject(input)) return null;

    const normalized = {
      v: Number(input.v),
      event: String(input.event || "").trim().toUpperCase(),
      projectId: input.projectId ?? input.project,
      taskId: input.taskId ?? input.task,
      runId: input.runId ?? input.run,
      agentId: input.agentId ?? input.agent,
      eventId: input.eventId,
      sequence: Number(input.sequence),
      payload: isPlainObject(input.payload) ? input.payload : {}
    };

    for (const key of ["commit", "branch", "summary", "reason", "message"]) {
      if (input[key] != null && normalized.payload[key] == null) {
        normalized.payload[key] = input[key];
      }
    }

    return normalized;
  }

  function validateEnvelope(input) {
    const event = normalizeEnvelope(input);
    if (!event) return { ok: false, reason: "envelope_not_object" };
    if (event.v !== VERSION) return { ok: false, reason: "unsupported_version", received: event.v };
    if (!EVENT_TYPE_SET.has(event.event)) return { ok: false, reason: "unknown_event", received: event.event };

    for (const field of ["projectId", "taskId", "runId", "agentId", "eventId"]) {
      const value = readString(event[field]);
      if (!value) return { ok: false, reason: "invalid_required_field", field };
      event[field] = value;
    }

    if (!Number.isSafeInteger(event.sequence) || event.sequence < 1) {
      return { ok: false, reason: "invalid_sequence" };
    }

    if (!isPlainObject(event.payload)) {
      return { ok: false, reason: "invalid_payload" };
    }

    return { ok: true, event };
  }

  function parseCompact(body) {
    const object = {};
    const seen = new Set();
    const parts = body.split("|").filter(Boolean);
    for (const part of parts) {
      const equals = part.indexOf("=");
      if (equals <= 0) return { ok: false, reason: "invalid_compact_field" };
      const key = part.slice(0, equals).trim();
      let value = part.slice(equals + 1).trim();
      if (!key) return { ok: false, reason: "invalid_compact_field" };
      if (seen.has(key)) return { ok: false, reason: "duplicate_compact_field", field: key };
      seen.add(key);
      try { value = decodeURIComponent(value); } catch (_) {}
      object[key] = value;
    }

    if (object.payload) {
      try {
        object.payload = JSON.parse(object.payload);
      } catch (_) {
        return { ok: false, reason: "invalid_compact_payload" };
      }
    }
    return { ok: true, value: object };
  }

  function parseLine(line, { maxEnvelopeLength = MAX_ENVELOPE_LENGTH } = {}) {
    const raw = String(line || "").trim();
    if (!raw.startsWith(PREFIX)) return { ok: false, reason: "missing_prefix" };
    if (raw.length > maxEnvelopeLength) return { ok: false, reason: "envelope_too_large" };

    let decoded;
    const tail = raw.slice(PREFIX.length);
    if (tail.startsWith(" ")) {
      try {
        decoded = JSON.parse(tail.trim());
      } catch (_) {
        return { ok: false, reason: "invalid_json" };
      }
    } else if (tail.startsWith("|")) {
      const compact = parseCompact(tail.slice(1));
      if (!compact.ok) return compact;
      decoded = compact.value;
    } else {
      return { ok: false, reason: "invalid_prefix_separator" };
    }

    return validateEnvelope(decoded);
  }

  function routeForEvent(eventType) {
    return ROUTES[String(eventType || "").toUpperCase()] || null;
  }

  root.OrchestraProtocol = Object.freeze({
    VERSION,
    PREFIX,
    EVENT_TYPES,
    ROUTES,
    MAX_ENVELOPE_LENGTH,
    normalizeEnvelope,
    validateEnvelope,
    parseLine,
    routeForEvent
  });

  if (typeof module !== "undefined" && module.exports) {
    module.exports = root.OrchestraProtocol;
  }
})();
