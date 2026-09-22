"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_FILES = 4;
const DEFAULT_MAX_STRING_BYTES = 8192;
const MAX_DEPTH = 8;
const MAX_COLLECTION_ITEMS = 100;

const SENSITIVE_KEY_PATTERN = /(?:authorization|cookie|set-cookie|token|secret|password|passphrase|credential|api[_-]?key|client[_-]?secret|pairing[_-]?secret|csrf|code[_-]?verifier)/i;
const CONTENT_KEY_PATTERN = /^(?:prompt|assistantText|responseText|html|serialized)$/i;

function byteLength(value) {
  return Buffer.byteLength(String(value ?? ""), "utf8");
}

function truncateString(value, maxBytes = DEFAULT_MAX_STRING_BYTES) {
  const text = String(value ?? "");
  if (byteLength(text) <= maxBytes) return text;
  const suffix = `…[truncated:${byteLength(text)} bytes]`;
  const available = Math.max(0, maxBytes - byteLength(suffix));
  return Buffer.from(text, "utf8").subarray(0, available).toString("utf8") + suffix;
}

function sanitizeUrlString(value) {
  const text = String(value ?? "");
  if (!/^https?:\/\//i.test(text)) return text;
  try {
    const parsed = new URL(text);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch (_) {
    return text;
  }
}

function omittedContent(value) {
  if (typeof value === "string") return `[omitted:${byteLength(value)} bytes]`;
  return "[omitted]";
}

function mergeDetails(baseDetails, details) {
  const base = baseDetails && typeof baseDetails === "object" && !Array.isArray(baseDetails) && !(baseDetails instanceof Error)
    ? baseDetails
    : { context: baseDetails };
  if (details === undefined || details === null) return { ...base };
  if (details && typeof details === "object" && !Array.isArray(details) && !(details instanceof Error)) {
    return { ...base, ...details };
  }
  return { ...base, value: details };
}

function sanitizeValue(value, {
  key = "",
  seen = new WeakSet(),
  depth = 0,
  maxStringBytes = DEFAULT_MAX_STRING_BYTES
} = {}) {
  if (SENSITIVE_KEY_PATTERN.test(String(key || ""))) return "[redacted]";
  if (CONTENT_KEY_PATTERN.test(String(key || ""))) return omittedContent(value);
  if (value === null || value === undefined) return value ?? null;
  if (value instanceof Error) {
    return {
      name: truncateString(value.name || "Error", maxStringBytes),
      message: truncateString(value.message || "", maxStringBytes),
      stack: truncateString(value.stack || "", maxStringBytes)
    };
  }
  if (typeof value === "string") return truncateString(sanitizeUrlString(value), maxStringBytes);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "boolean") return value;
  if (typeof value === "function") return "[function]";
  if (typeof value === "symbol") return String(value);
  if (typeof value !== "object") return truncateString(String(value), maxStringBytes);
  if (depth >= MAX_DEPTH) return "[max-depth]";
  if (seen.has(value)) return "[circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_COLLECTION_ITEMS).map((item) => sanitizeValue(item, {
      seen,
      depth: depth + 1,
      maxStringBytes
    }));
    if (value.length > MAX_COLLECTION_ITEMS) items.push(`[omitted:${value.length - MAX_COLLECTION_ITEMS} items]`);
    return items;
  }

  const entries = Object.entries(value).slice(0, MAX_COLLECTION_ITEMS);
  const result = {};
  for (const [entryKey, entryValue] of entries) {
    result[entryKey] = sanitizeValue(entryValue, {
      key: entryKey,
      seen,
      depth: depth + 1,
      maxStringBytes
    });
  }
  if (Object.keys(value).length > entries.length) result.__omittedKeys = Object.keys(value).length - entries.length;
  return result;
}

class StructuredLogger {
  constructor({
    filename,
    clock = () => Date.now(),
    consoleTarget = console,
    component = "desktop",
    baseDetails = {},
    instanceId = crypto.randomUUID(),
    maxBytes = DEFAULT_MAX_BYTES,
    maxFiles = DEFAULT_MAX_FILES,
    maxStringBytes = DEFAULT_MAX_STRING_BYTES,
    state = null
  } = {}) {
    if (!filename) throw new TypeError("structured_log_filename_required");
    this.filename = filename;
    this.clock = clock;
    this.consoleTarget = consoleTarget;
    this.component = String(component || "desktop");
    this.baseDetails = sanitizeValue(baseDetails, { maxStringBytes });
    this.instanceId = String(instanceId || crypto.randomUUID());
    this.maxBytes = Math.max(1024, Number(maxBytes) || DEFAULT_MAX_BYTES);
    this.maxFiles = Math.max(1, Number(maxFiles) || DEFAULT_MAX_FILES);
    this.maxStringBytes = Math.max(256, Number(maxStringBytes) || DEFAULT_MAX_STRING_BYTES);
    this.state = state || { sequence: 0 };
    fs.mkdirSync(path.dirname(this.filename), { recursive: true });
  }

  child(component, baseDetails = {}) {
    return new StructuredLogger({
      filename: this.filename,
      clock: this.clock,
      consoleTarget: this.consoleTarget,
      component: String(component || this.component),
      baseDetails: { ...(this.baseDetails || {}), ...(baseDetails || {}) },
      instanceId: this.instanceId,
      maxBytes: this.maxBytes,
      maxFiles: this.maxFiles,
      maxStringBytes: this.maxStringBytes,
      state: this.state
    });
  }

  rotateIfNeeded(nextBytes) {
    let size = 0;
    try { size = fs.statSync(this.filename).size; } catch (error) { if (error?.code !== "ENOENT") throw error; }
    if (!size || size + nextBytes <= this.maxBytes) return false;

    for (let index = this.maxFiles - 1; index >= 1; index -= 1) {
      const source = `${this.filename}.${index}`;
      const destination = `${this.filename}.${index + 1}`;
      try { fs.unlinkSync(destination); } catch (error) { if (error?.code !== "ENOENT") throw error; }
      try { fs.renameSync(source, destination); } catch (error) { if (error?.code !== "ENOENT") throw error; }
    }
    const firstArchive = `${this.filename}.1`;
    try { fs.unlinkSync(firstArchive); } catch (error) { if (error?.code !== "ENOENT") throw error; }
    fs.renameSync(this.filename, firstArchive);
    return true;
  }

  write(level, event, details = {}) {
    const record = {
      ts: new Date(this.clock()).toISOString(),
      seq: ++this.state.sequence,
      instanceId: this.instanceId,
      pid: process.pid,
      level: String(level || "info"),
      component: this.component,
      event: String(event || "desktop_event"),
      details: sanitizeValue(mergeDetails(this.baseDetails, details), { maxStringBytes: this.maxStringBytes })
    };
    const line = `${JSON.stringify(record)}\n`;
    try {
      this.rotateIfNeeded(byteLength(line));
      fs.appendFileSync(this.filename, line, "utf8");
    } catch (error) {
      this.consoleTarget?.error?.("[ChatGPT Orchestra] structured_log_write_failed", {
        event: record.event,
        error: String(error?.message || error)
      });
    }

    const method = record.level === "error"
      ? "error"
      : record.level === "warn"
        ? "warn"
        : record.level === "debug"
          ? "debug"
          : "log";
    this.consoleTarget?.[method]?.(`[ChatGPT Orchestra] ${record.component}:${record.event}`, record.details);
    return record;
  }

  debug(event, details) { return this.write("debug", event, details); }
  log(event, details) { return this.write("info", event, details); }
  info(event, details) { return this.write("info", event, details); }
  warn(event, details) { return this.write("warn", event, details); }
  error(event, details) { return this.write("error", event, details); }
}

module.exports = {
  StructuredLogger,
  sanitizeValue,
  sanitizeUrlString,
  mergeDetails,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_FILES,
  DEFAULT_MAX_STRING_BYTES
};
