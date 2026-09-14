"use strict";

const fs = require("node:fs");

function serializeValue(value) {
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack || "" };
  if (value === undefined) return null;
  if (typeof value === "bigint") return value.toString();
  return value;
}

class StructuredLogger {
  constructor({ filename, clock = () => Date.now(), consoleTarget = console } = {}) {
    if (!filename) throw new TypeError("structured_log_filename_required");
    this.filename = filename;
    this.clock = clock;
    this.consoleTarget = consoleTarget;
  }

  write(level, event, details = {}) {
    const record = {
      ts: new Date(this.clock()).toISOString(),
      level: String(level || "info"),
      event: String(event || "desktop_event"),
      details: JSON.parse(JSON.stringify(details || {}, (_key, value) => serializeValue(value)))
    };
    fs.appendFileSync(this.filename, `${JSON.stringify(record)}\n`, "utf8");
    const method = record.level === "error" ? "error" : record.level === "warn" ? "warn" : "log";
    this.consoleTarget?.[method]?.(`[ChatGPT Orchestra] ${record.event}`, record.details);
    return record;
  }

  log(event, details) { return this.write("info", event, details); }
  info(event, details) { return this.write("info", event, details); }
  warn(event, details) { return this.write("warn", event, details); }
  error(event, details) { return this.write("error", event, details); }
}

module.exports = { StructuredLogger };
