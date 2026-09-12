# 0003 — Persisted staged planning pipeline

Status: Accepted
Date: 2026-09-12

## Context

Phase 4 needs to turn a user goal and repository into an execution graph. A single long Lead prompt is attractive because it is simple, but it has poor review boundaries, makes critique superficial, grows chat context, and is difficult to recover safely after a service-worker/browser interruption.

Planning artifacts can also be substantially larger than the bounded Orchestra Protocol v1 envelope. Treating the chat transcript as the artifact store would violate the project invariant that ChatGPT tabs are replaceable executors rather than the source of truth.

## Decision

Planning is implemented as a persisted state machine:

`DISCOVERY -> PLAN_V1 -> CRITIQUE -> PLAN_V2 -> DECOMPOSE -> DAG_CRITIC -> deterministic validation -> READY`.

For every stage:

- Project Store persists stage/run state before dispatch;
- Lead receives a versioned prompt built from immutable project input and persisted prior artifacts;
- Lead is bound to that stage's exact `projectId/taskId/runId` protocol context;
- the large stage artifact is emitted in a bounded `@@ORCH_ARTIFACT_BEGIN/END` JSON block;
- the final line remains a small Orchestra Protocol v1 event carrying identity and stage only;
- accepted event source metadata persists the parsed artifact to cover the crash window before Project Store advances;
- the next stage is dispatched only after the current stage event and artifact are accepted.

The final task graph must pass deterministic DAG validation before the project becomes `READY`.

Existing repository instructions, including `AGENTS.md`, are inputs to discovery/planning. Phase 4 may produce an `agentsMdProposal`, but it does not overwrite repository instructions automatically.

## Consequences

Benefits:

- planning survives replacement/reload of the Lead chat more cleanly;
- each stage has a narrow contract and can be audited independently;
- Critic is structurally separated from the first plan;
- stale stage/run outputs are rejected by the existing Event Bus context checks;
- large artifacts do not weaken the Protocol v1 envelope bound;
- accepted events remain recoverable even if the service worker dies before the Project Store write;
- `READY` has a deterministic meaning instead of being a model assertion.

Costs:

- planning takes multiple model turns;
- artifacts are temporarily duplicated between accepted-event provenance and Project Store, increasing local storage usage;
- the alpha still uses one Lead executor for the planning roles, so role diversity is logical rather than separate-chat diversity;
- full historical compaction/storage migration remains future reliability work.

## Alternatives considered

### One monolithic planning prompt

Rejected because critique/decomposition boundaries become soft, recovery is ambiguous and a large response becomes one failure domain.

### Put the entire plan/DAG inside `@@ORCH` payload

Rejected because Protocol v1 deliberately has a small envelope limit and large task graphs can exceed it.

### Keep planning artifacts only in the ChatGPT transcript

Rejected because it makes the chat the source of truth and prevents deterministic crash recovery.

### Store only in Project Store after Event Bus acceptance

Rejected because a crash between accepted event persistence and Project Store update would leave an event marked processed but its planning artifact unavailable for recovery.
