# Phase 3 — Orchestra Protocol v1 + Event Bus

Phase 3 replaces free-form inter-agent status flags with a versioned, machine-readable protocol carried in the final non-empty line of a ChatGPT assistant response.

## Envelope

Preferred form:

```text
@@ORCH {"v":1,"event":"DONE","projectId":"P1","taskId":"T17","runId":"R4","agentId":"A2","eventId":"E91","sequence":3,"payload":{"commit":"abc123"}}
```

Compact fallback:

```text
@@ORCH|v=1|event=DONE|projectId=P1|taskId=T17|runId=R4|agentId=A2|eventId=E91|sequence=3
```

The parser reads only the last non-empty line. `@@ORCH` has priority over legacy marker matching.

## Required fields

Every accepted event must contain:

- `v` — protocol version, currently exactly `1`;
- `event` — known event type;
- `projectId`;
- `taskId`;
- `runId`;
- `agentId`;
- `eventId`;
- `sequence` — positive safe integer;
- `payload` — object, optional in source and normalized to `{}`.

IDs are trimmed, non-empty and length-limited. The complete envelope is size-limited.

## Event types and routes

| Event | Route |
|---|---|
| `READY` | lifecycle |
| `TASK_ACCEPTED` | lifecycle |
| `PROGRESS` | progress |
| `DONE` | completion |
| `BLOCKED` | blocker |
| `ERROR` | blocker |
| `REVIEW_APPROVED` | review |
| `CHANGES_REQUIRED` | review |
| `CONFLICT` | integration |
| `CONFLICT_RESOLVED` | integration |
| `NEEDS_USER` | user |
| `HEARTBEAT` | lifecycle |

Unknown event types are rejected and audited; they never trigger automatic side effects.

## Sender identity

A protocol event is accepted only when:

1. the runtime sender has a real `tabId`;
2. that tab is registered in `TabRegistry`;
3. the envelope `agentId` exactly matches the logical agent bound to that tab.

This prevents a normal ChatGPT tab or another worker from impersonating an Orchestra agent by printing a valid-looking envelope.

## Protocol context

`TabRegistry` can bind an agent to an expected protocol context:

```json
{
  "projectId": "P1",
  "taskId": "T17",
  "runId": "R4"
}
```

When a field is bound, incoming events must match it exactly. A mismatch is rejected before the event is accepted.

Phase 3 provides the mechanism. Future project/task schedulers will own when bindings are created, advanced and cleared.

## Idempotency

`EventStore` persists processed event IDs in `chrome.storage.local`.

An exact replay is safe:

```text
same eventId + same complete normalized event => duplicate=true
```

It does not append a second accepted event or rerun route listeners.

A reused ID with changed content is not a duplicate:

```text
same eventId + changed payload/identity => event_id_collision
```

For exact comparison the store persists a canonical event signature with sorted object keys.

## Sequence monotonicity

Sequence is tracked independently for each:

```text
projectId : taskId : runId : agentId
```

An event is stale when:

```text
incoming sequence <= last accepted sequence
```

Gaps are permitted in v1. This makes the rule monotonic without requiring the orchestrator to assume every intermediate model event was emitted.

## Persistence

The event store keeps:

```text
schemaVersion
eventCursor
processedEvents
processedOrder
sequences
events
rejections
updatedAt
```

Accepted event history, processed-ID history and rejection history have bounded retention limits so one long-running project cannot grow extension storage without bound.

The processed-ID set is intentionally larger than the visible accepted-event history: idempotency must survive event-log trimming.

## Malformed protocol

If the final response line starts with `@@ORCH` but is invalid, content reports a `PROTOCOL_ERROR` instead of falling through to legacy rules.

Examples:

- invalid JSON;
- unsupported `v`;
- unknown event type;
- missing identity field;
- invalid sequence;
- oversized envelope.

The service worker persists a bounded rejection audit with reason and limited diagnostic fields.

## Legacy compatibility

Responses without `@@ORCH` continue through the existing legacy rule parser:

```text
DONE
FAIL
ERROR
```

This compatibility path remains intentionally separate from Orchestra Protocol semantics. A legacy `DONE` is not equivalent to a protocol `DONE` with project/run identity.

## Phase boundary

Phase 3 does not interpret `DONE` as a merge, task verification or project completion. It only guarantees that an accepted event is valid, attributable, ordered, persisted and safely replayable.

Project state transitions begin in later phases and must consume accepted Event Bus records rather than reparsing arbitrary chat text.
