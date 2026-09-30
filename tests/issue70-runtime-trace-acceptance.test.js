"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  validateIssue70Trace,
  REQUIRED_EVENTS
} = require("../scripts/validate-issue70-runtime-trace.js");

const BASE = Date.parse("2026-09-30T10:00:00.000Z");

function record(seq, event, extra = {}, traceId = "trace-good", projectId = "project-existing") {
  return {
    ts: new Date(BASE + seq * 1000).toISOString(),
    seq,
    event,
    details: {
      traceId,
      projectId,
      taskId: "planning:discovery",
      runId: "run-1",
      agentId: "desktop-agent-1",
      stage: "DISCOVERY",
      ...extra
    }
  };
}

function successfulTrace({ traceId = "trace-good", projectId = "project-existing", offset = 0 } = {}) {
  let seq = offset;
  const rows = [];
  const push = (event, extra = {}) => rows.push(record(++seq, event, extra, traceId, projectId));

  push("planning_stage_dispatch_started", { promptBytes: 42 });
  push("managed_browser_completion_prepare_completed", { messageCount: 2, fingerprint: "base" });
  push("managed_browser_prompt_send_started", { promptBytes: 42 });
  push("managed_browser_prompt_send_completed", {
    promptAccepted: true,
    promptConfirmed: true,
    confirmationMethod: "submit-confirmed"
  });
  push("managed_browser_generation_started", { generating: true });
  push("managed_browser_assistant_change_detected", { responseFingerprint: "partial" });
  push("managed_browser_generation_stopped", { generating: false });
  push("managed_browser_completion_stable", {
    responseBytes: 256,
    responseFingerprint: "final",
    stablePollCount: 2
  });
  push("managed_browser_protocol_parsed", { eventId: "event-1", event: "DONE" });
  push("orchestra_event_accepted", { eventId: "event-1", duplicate: false });
  push("orchestra_event_apply_started", { eventId: "event-1" });
  push("planning_completion_consumed", { eventId: "event-1" });
  push("planning_stage_completed", { eventId: "event-1" });
  push("planning_stage_advancing", { fromStage: "DISCOVERY", toStage: "PLAN_V1" });
  push("orchestra_event_applied", {
    eventId: "event-1",
    planningConsumed: true,
    planningAdvanced: true
  });
  push("managed_browser_protocol_event_submitted", {
    eventId: "event-1",
    accepted: true,
    applied: true,
    planningConsumed: true,
    planningAdvanced: true
  });
  push("runtime_trace_completed", {
    protocolAccepted: true,
    protocolApplied: true,
    planningConsumed: true,
    planningAdvanced: true
  });
  return rows;
}

test("issue #70 acceptance validator passes one fresh complete trace from a pre-existing persisted project", () => {
  const records = successfulTrace();
  const result = validateIssue70Trace(records, {
    afterMs: BASE,
    persistedProjects: {
      "project-existing": {
        projectId: "project-existing",
        createdAt: BASE - 60_000
      }
    }
  });

  assert.equal(result.ok, true, result.errors.join("\n"));
  assert.equal(result.traceId, "trace-good");
  assert.equal(result.terminalEvent, "runtime_trace_completed");
  for (const event of REQUIRED_EVENTS) assert.ok(result.events.includes(event), event);
});

test("issue #70 acceptance validator rejects a trace for a project created during the acceptance run", () => {
  const result = validateIssue70Trace(successfulTrace(), {
    afterMs: BASE,
    persistedProjects: {
      "project-existing": {
        projectId: "project-existing",
        createdAt: BASE + 1
      }
    }
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /created during the acceptance run/);
});

test("issue #70 acceptance validator rejects missing prompt confirmation and missing required stages", () => {
  const records = successfulTrace()
    .filter((row) => row.event !== "managed_browser_generation_started")
    .map((row) => row.event === "managed_browser_prompt_send_completed"
      ? { ...row, details: { ...row.details, promptConfirmed: false } }
      : row);

  const result = validateIssue70Trace(records, {
    afterMs: BASE,
    persistedProjects: {
      "project-existing": {
        projectId: "project-existing",
        createdAt: BASE - 60_000
      }
    }
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /managed_browser_generation_started/);
  assert.match(result.errors.join("\n"), /prompt was not explicitly confirmed/);
});

test("issue #70 acceptance validator does not hide a newer failed terminal trace behind an older successful one", () => {
  const good = successfulTrace({ traceId: "trace-old", offset: 0 });
  const failed = [
    record(100, "planning_stage_dispatch_started", {}, "trace-new", "project-existing"),
    record(101, "runtime_trace_failed", {
      reason: "completion_timeout",
      protocolAccepted: false,
      protocolApplied: false,
      planningConsumed: false,
      planningAdvanced: false
    }, "trace-new", "project-existing")
  ];

  const result = validateIssue70Trace([...good, ...failed], {
    afterMs: BASE,
    persistedProjects: {
      "project-existing": {
        projectId: "project-existing",
        createdAt: BASE - 60_000
      }
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.traceId, "trace-new");
  assert.equal(result.terminalEvent, "runtime_trace_failed");
});

test("issue #70 acceptance validator rejects raw sensitive/content fields in the selected real trace", () => {
  const records = successfulTrace().map((row) => row.event === "managed_browser_completion_stable"
    ? {
        ...row,
        details: {
          ...row.details,
          assistantText: "SHOULD_NOT_BE_PERSISTED",
          accessToken: "SHOULD_NOT_BE_PERSISTED"
        }
      }
    : row);

  const result = validateIssue70Trace(records, {
    afterMs: BASE,
    persistedProjects: {
      "project-existing": {
        projectId: "project-existing",
        createdAt: BASE - 60_000
      }
    }
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /raw content field persisted/);
  assert.match(result.errors.join("\n"), /sensitive field was not redacted/);
});
