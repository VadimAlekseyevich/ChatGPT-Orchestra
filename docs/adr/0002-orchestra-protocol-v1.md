# 0002 — Orchestra Protocol v1 and persisted event identity

Status: Accepted
Date: 2026-09-12

## Context

Legacy flags such as `DONE`, `FAIL` and `ERROR` are useful for a single sequential automation loop but do not identify the project, task, execution attempt, agent or unique event that produced them. In a multi-agent system the same visible text can be replayed after reload, observed twice, emitted by the wrong tab or belong to a stale run.

Direct chat-to-chat routing would also make recovery depend on transient browser state and conversation history.

## Decision

ChatGPT Orchestra adopts a versioned machine-readable final-line protocol with prefix `@@ORCH`.

Every v1 event carries:

- protocol version;
- event type;
- `projectId`;
- `taskId`;
- `runId`;
- `agentId`;
- globally unique `eventId` within the orchestration domain;
- positive monotonic `sequence` within a project/task/run/agent stream;
- structured payload.

The extension service worker owns acceptance semantics through a persisted Event Bus. Content scripts may parse and submit candidate events but cannot decide whether they are fresh, authorized or already processed.

An exact replay of the same normalized event is idempotent. Reuse of an `eventId` with changed content is an error. Sender tab identity must match `agentId`. When an expected project/task/run context is bound to an agent, the event must match that context.

Malformed or unknown protocol input is audited and produces no automatic destructive side effect.

Legacy flags remain a compatibility path but are not considered equivalent to Orchestra Protocol events.

## Consequences

Positive consequences:

- event replay after reload is deterministic;
- duplicate model output does not automatically repeat a side effect;
- stale runs can be rejected explicitly;
- event routing no longer depends on prose interpretation;
- future scheduler/review/integration modules receive typed, attributable records;
- recovery can use persisted event identity rather than chat memory.

Costs and constraints:

- prompts must instruct agents to emit valid envelopes;
- event IDs and sequences must be generated consistently;
- extension storage now contains bounded event/rejection state;
- future state transitions must consume Event Bus records rather than bypassing the protocol;
- protocol evolution requires explicit version handling.

## Alternatives considered

### Keep simple flags

Rejected because flags do not provide enough identity for multiple concurrent tasks and cannot distinguish replay from new work.

### Let chats communicate directly

Rejected because routing and state would become dependent on transient tabs and duplicated context.

### Free-form JSON anywhere in the response

Rejected because extracting arbitrary JSON from model prose is ambiguous. Restricting the envelope to the last non-empty line gives a deterministic parser boundary.

### Require strict consecutive sequence numbers

Not selected for v1. Sequence must increase monotonically, but gaps are allowed so the orchestrator does not assume that every possible intermediate progress event was emitted or observed.
