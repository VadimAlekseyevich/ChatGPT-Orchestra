"use strict";

const crypto = require("node:crypto");

const TRACE_FIELDS = Object.freeze([
  "traceId",
  "projectId",
  "taskId",
  "runId",
  "agentId",
  "stage",
  "sessionId",
  "dispatchKind",
  "startedAt"
]);

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeTraceContext(value = null, fallback = {}) {
  const source = isObject(value?.trace) ? value.trace : (isObject(value) ? value : {});
  const base = isObject(fallback?.trace) ? fallback.trace : (isObject(fallback) ? fallback : {});
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

function traceDetails(trace, details = {}) {
  return { ...normalizeTraceContext(trace), ...(isObject(details) ? details : { value: details }) };
}

function traceDurationMs(trace, now = Date.now()) {
  const startedAt = Number(normalizeTraceContext(trace).startedAt);
  if (!Number.isFinite(startedAt) || startedAt <= 0) return null;
  return Math.max(0, Number(now) - startedAt);
}

function byteLength(value) {
  return Buffer.byteLength(String(value ?? ""), "utf8");
}

function hashText(value) {
  const text = String(value ?? "");
  if (!text) return "";
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function safeProtocolValue(value) {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === "string") {
    return {
      bytes: byteLength(value),
      fingerprint: hashText(value)
    };
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  return {
    bytes: byteLength(JSON.stringify(value)),
    fingerprint: hashText(JSON.stringify(value))
  };
}

function snapshotMetadata(snapshot = {}) {
  return {
    messageCount: Math.max(0, Number(snapshot.messageCount) || 0),
    fingerprint: String(snapshot.fingerprint || ""),
    availability: String(snapshot.availability || "unavailable"),
    generating: Boolean(snapshot.generating),
    pathname: String(snapshot.pathname || "")
  };
}

module.exports = {
  TRACE_FIELDS,
  normalizeTraceContext,
  traceDetails,
  traceDurationMs,
  byteLength,
  hashText,
  safeProtocolValue,
  snapshotMetadata
};
