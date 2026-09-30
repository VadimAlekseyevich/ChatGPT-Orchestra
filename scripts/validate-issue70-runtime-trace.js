"use strict";

const fs = require("node:fs");
const path = require("node:path");

const PROJECT_STATE_KEY = "orchestra.projects.v1";
const TERMINAL_EVENTS = new Set([
  "runtime_trace_completed",
  "runtime_trace_failed",
  "runtime_trace_cancelled",
  "runtime_trace_timed_out"
]);

const REQUIRED_EVENTS = Object.freeze([
  "planning_stage_dispatch_started",
  "managed_browser_completion_prepare_completed",
  "managed_browser_prompt_send_started",
  "managed_browser_prompt_send_completed",
  "managed_browser_generation_started",
  "managed_browser_assistant_change_detected",
  "managed_browser_generation_stopped",
  "managed_browser_completion_stable",
  "managed_browser_protocol_parsed",
  "orchestra_event_accepted",
  "orchestra_event_applied",
  "planning_completion_consumed",
  "planning_stage_completed",
  "planning_stage_advancing",
  "managed_browser_protocol_event_submitted",
  "runtime_trace_completed"
]);

const ORDERED_EVENTS = Object.freeze([
  "planning_stage_dispatch_started",
  "managed_browser_completion_prepare_completed",
  "managed_browser_prompt_send_started",
  "managed_browser_prompt_send_completed",
  "managed_browser_generation_started",
  "managed_browser_assistant_change_detected",
  "managed_browser_generation_stopped",
  "managed_browser_completion_stable",
  "managed_browser_protocol_parsed",
  "orchestra_event_accepted",
  "planning_completion_consumed",
  "planning_stage_completed",
  "planning_stage_advancing",
  "orchestra_event_applied",
  "managed_browser_protocol_event_submitted",
  "runtime_trace_completed"
]);

const IDENTITY_FIELDS = Object.freeze(["projectId", "taskId", "runId", "agentId", "stage"]);
const SENSITIVE_KEY = /(?:authorization|cookie|set-cookie|token|secret|password|passphrase|credential|api[_-]?key|client[_-]?secret|pairing[_-]?secret|csrf|code[_-]?verifier)/i;
const CONTENT_KEY = /^(?:prompt|assistantText|responseText|html|serialized)$/i;

function timestampMs(record) {
  const parsed = Date.parse(String(record && record.ts || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function sortRecords(records) {
  return [...records].sort((a, b) => {
    const timeDelta = timestampMs(a) - timestampMs(b);
    if (timeDelta) return timeDelta;
    return (Number(a && a.seq) || 0) - (Number(b && b.seq) || 0);
  });
}

function collectLogFiles(logFile) {
  const absolute = path.resolve(String(logFile || ""));
  const files = [];
  for (let index = 4; index >= 1; index -= 1) {
    const archive = absolute + "." + index;
    if (fs.existsSync(archive)) files.push(archive);
  }
  if (fs.existsSync(absolute)) files.push(absolute);
  if (!files.length) throw new Error("issue70_log_not_found: " + absolute);
  return files;
}

function loadJsonlRecords(logFile) {
  const records = [];
  for (const filename of collectLogFiles(logFile)) {
    const text = fs.readFileSync(filename, "utf8");
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim();
      if (!line) continue;
      try {
        const record = JSON.parse(line);
        if (record && typeof record === "object") records.push(record);
      } catch (error) {
        throw new Error("issue70_invalid_jsonl: " + filename + ":" + (index + 1) + ": " + error.message);
      }
    }
  }
  return sortRecords(records);
}

function loadPersistedProjectState(databaseFile) {
  if (!fs.existsSync(databaseFile)) {
    throw new Error("issue70_state_database_not_found: " + databaseFile);
  }

  let DatabaseSync;
  try {
    DatabaseSync = require("node:sqlite").DatabaseSync;
  } catch (error) {
    const wrapped = new Error("issue70_sqlite_runtime_unavailable: use Node.js 22+");
    wrapped.cause = error;
    throw wrapped;
  }

  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    const row = db.prepare("SELECT value FROM orchestra_kv WHERE key = ?").get(PROJECT_STATE_KEY);
    if (!row || typeof row.value !== "string") {
      throw new Error("issue70_persisted_project_state_missing");
    }
    const state = JSON.parse(row.value);
    if (!state || typeof state !== "object" || !state.projects || typeof state.projects !== "object") {
      throw new Error("issue70_persisted_project_state_invalid");
    }
    return state;
  } finally {
    db.close();
  }
}

function scanPrivacy(value, errors, location) {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanPrivacy(item, errors, location + "[" + index + "]"));
    return;
  }
  if (typeof value !== "object") return;

  for (const [key, child] of Object.entries(value)) {
    const childLocation = location + "." + key;
    if (CONTENT_KEY.test(key) && typeof child === "string" && !child.startsWith("[omitted")) {
      errors.push("raw content field persisted at " + childLocation);
    }
    if (SENSITIVE_KEY.test(key) && child !== "[redacted]") {
      errors.push("sensitive field was not redacted at " + childLocation);
    }
    if (typeof child === "string" && /^https?:\/\//i.test(child)) {
      try {
        const parsed = new URL(child);
        if (parsed.search || parsed.hash || parsed.username || parsed.password) {
          errors.push("unsafe URL metadata persisted at " + childLocation);
        }
      } catch (_) {}
    }
    scanPrivacy(child, errors, childLocation);
  }
}

function firstEvent(records, event) {
  return records.find((record) => record && record.event === event) || null;
}

function eventIndex(records, event) {
  return records.findIndex((record) => record && record.event === event);
}

function selectTrace(records, { afterMs = 0, projectId = null, traceId = null } = {}) {
  const terminals = records.filter((record) => {
    if (!TERMINAL_EVENTS.has(String(record && record.event || ""))) return false;
    const details = record && record.details || {};
    if (!details.traceId) return false;
    if (traceId && details.traceId !== traceId) return false;
    if (projectId && details.projectId !== projectId) return false;
    if (afterMs && timestampMs(record) < afterMs) return false;
    return true;
  });

  if (!terminals.length) return null;
  return sortRecords(terminals).at(-1) || null;
}

function validateIssue70Trace(records, {
  afterMs = 0,
  projectId = null,
  traceId = null,
  persistedProjects = null
} = {}) {
  const errors = [];
  const warnings = [];
  const selectedTerminal = selectTrace(records, { afterMs, projectId, traceId });

  if (!selectedTerminal) {
    return {
      ok: false,
      errors: ["no terminal runtime trace found for the requested acceptance window"],
      warnings,
      traceId: traceId || null,
      projectId: projectId || null,
      terminalEvent: null,
      events: []
    };
  }

  const selectedTraceId = String(selectedTerminal.details && selectedTerminal.details.traceId || "");
  const traceRecords = sortRecords(records.filter((record) => {
    return String(record && record.details && record.details.traceId || "") === selectedTraceId;
  }));
  const selectedProjectId = String(selectedTerminal.details && selectedTerminal.details.projectId || "");
  const events = traceRecords.map((record) => String(record.event || ""));

  const terminals = traceRecords.filter((record) => TERMINAL_EVENTS.has(String(record.event || "")));
  if (terminals.length !== 1) {
    errors.push("expected exactly one terminal trace event, found " + terminals.length);
  }
  if (selectedTerminal.event !== "runtime_trace_completed") {
    errors.push("latest trace terminated as " + selectedTerminal.event);
  }

  for (const event of REQUIRED_EVENTS) {
    if (!events.includes(event)) errors.push("missing trace event: " + event);
  }

  let previousIndex = -1;
  for (const event of ORDERED_EVENTS) {
    const index = eventIndex(traceRecords, event);
    if (index < 0) continue;
    if (index < previousIndex) {
      errors.push("trace ordering violation near event: " + event);
      break;
    }
    previousIndex = index;
  }

  for (const field of IDENTITY_FIELDS) {
    const values = [...new Set(traceRecords
      .map((record) => record && record.details && record.details[field])
      .filter((value) => value !== null && value !== undefined && String(value) !== "")
      .map(String))];
    if (values.length === 0) errors.push("trace identity missing: " + field);
    if (values.length > 1) errors.push("trace identity changed for " + field + ": " + values.join(", "));
  }

  const prompt = firstEvent(traceRecords, "managed_browser_prompt_send_completed");
  if (prompt && prompt.details && prompt.details.promptAccepted !== true) {
    errors.push("prompt was not explicitly accepted");
  }
  if (prompt && prompt.details && prompt.details.promptConfirmed !== true) {
    errors.push("prompt was not explicitly confirmed");
  }

  const stable = firstEvent(traceRecords, "managed_browser_completion_stable");
  if (stable) {
    const bytes = Number(stable.details && stable.details.responseBytes);
    if (!Number.isFinite(bytes) || bytes <= 0) errors.push("stable assistant response has no positive responseBytes");
    if (!String(stable.details && stable.details.responseFingerprint || "")) {
      errors.push("stable assistant response fingerprint is missing");
    }
  }

  const parsed = firstEvent(traceRecords, "managed_browser_protocol_parsed");
  if (parsed && !String(parsed.details && parsed.details.eventId || "")) {
    errors.push("protocol parse did not produce an Orchestra eventId");
  }

  const submitted = firstEvent(traceRecords, "managed_browser_protocol_event_submitted");
  if (submitted) {
    if (submitted.details && submitted.details.accepted !== true) errors.push("protocol event was not accepted");
    if (submitted.details && submitted.details.applied !== true) errors.push("protocol event was not applied");
    if (submitted.details && submitted.details.planningConsumed !== true) errors.push("planning did not consume the protocol event");
    if (submitted.details && submitted.details.planningAdvanced !== true) errors.push("planning did not advance after the protocol event");
  }

  const applied = firstEvent(traceRecords, "orchestra_event_applied");
  if (applied) {
    if (applied.details && applied.details.planningConsumed !== true) errors.push("EventBus applied event without planningConsumed=true");
    if (applied.details && applied.details.planningAdvanced !== true) errors.push("EventBus applied event without planningAdvanced=true");
  }

  if (selectedTerminal.details) {
    if (selectedTerminal.details.protocolAccepted !== true) errors.push("terminal trace has protocolAccepted!=true");
    if (selectedTerminal.details.protocolApplied !== true) errors.push("terminal trace has protocolApplied!=true");
    if (selectedTerminal.details.planningConsumed !== true) errors.push("terminal trace has planningConsumed!=true");
    if (selectedTerminal.details.planningAdvanced !== true) errors.push("terminal trace has planningAdvanced!=true");
  }

  if (afterMs && timestampMs(selectedTerminal) < afterMs) {
    errors.push("selected trace predates the acceptance start");
  }

  if (persistedProjects) {
    const baseline = persistedProjects[selectedProjectId];
    if (!baseline) {
      errors.push("trace project was not present in persisted state before application launch: " + selectedProjectId);
    } else if (afterMs) {
      const createdAt = Number(baseline.createdAt);
      if (!Number.isFinite(createdAt) || createdAt <= 0) {
        errors.push("persisted project has no valid createdAt: " + selectedProjectId);
      } else if (createdAt >= afterMs) {
        errors.push("trace project was created during the acceptance run instead of being pre-existing: " + selectedProjectId);
      }
    }
  }

  for (const record of traceRecords) scanPrivacy(record, errors, "record");

  const failureEvents = traceRecords.filter((record) => /(?:_failed|_rejected)$/.test(String(record.event || "")));
  if (failureEvents.length) {
    warnings.push("trace contains failure/rejection events: " + failureEvents.map((record) => record.event).join(", "));
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    traceId: selectedTraceId,
    projectId: selectedProjectId || null,
    taskId: String(selectedTerminal.details && selectedTerminal.details.taskId || "") || null,
    runId: String(selectedTerminal.details && selectedTerminal.details.runId || "") || null,
    agentId: String(selectedTerminal.details && selectedTerminal.details.agentId || "") || null,
    stage: String(selectedTerminal.details && selectedTerminal.details.stage || "") || null,
    terminalEvent: selectedTerminal.event,
    terminalTimestamp: selectedTerminal.ts || null,
    events
  };
}

function printValidationResult(result) {
  const status = result && result.ok ? "PASS" : "FAIL";
  console.log("[Issue #70 acceptance] " + status);
  if (result && result.traceId) console.log("traceId: " + result.traceId);
  if (result && result.projectId) console.log("projectId: " + result.projectId);
  if (result && result.stage) console.log("stage: " + result.stage);
  if (result && result.runId) console.log("runId: " + result.runId);
  if (result && result.terminalEvent) console.log("terminal: " + result.terminalEvent);
  if (result && result.terminalTimestamp) console.log("terminal timestamp: " + result.terminalTimestamp);
  if (result && result.events && result.events.length) console.log("events: " + result.events.join(" -> "));
  for (const warning of result && result.warnings || []) console.warn("WARNING: " + warning);
  for (const error of result && result.errors || []) console.error("ERROR: " + error);
}

module.exports = {
  PROJECT_STATE_KEY,
  TERMINAL_EVENTS,
  REQUIRED_EVENTS,
  ORDERED_EVENTS,
  collectLogFiles,
  loadJsonlRecords,
  loadPersistedProjectState,
  validateIssue70Trace,
  printValidationResult
};
