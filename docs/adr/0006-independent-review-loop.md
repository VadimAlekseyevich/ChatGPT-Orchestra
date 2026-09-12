# 0006 — Independent review before dependency success

Status: Accepted
Date: 2026-09-12

## Context

Phase 6 proves that a Worker produced a real isolated Git artifact, but artifact provenance alone cannot prove that the implementation satisfies the task acceptance criteria. Letting the author approve its own work would collapse `WORK -> REVIEW -> APPROVE` into one self-reported event and propagate defects through the DAG.

A permanent dedicated Reviewer tab would also waste capacity and conflict with Orchestra's dynamic-role design.

## Decision

Phase 7 introduces a persisted independent review loop.

- Worker `DONE` after Git validation becomes `DONE_BY_WORKER`, not dependency success.
- A free Worker tab may temporarily act as Reviewer.
- The author agent of the reviewed Worker run is never an eligible Reviewer.
- Review has its own `reviewId`, protocol context and persisted state.
- Review packet contains bounded task/artifact/diff/test context rather than full Worker transcript.
- Approval is structured and must explicitly pass every acceptance criterion, scope and test assessment.
- `CHANGES_REQUIRED` creates a new Worker run and unique branch with structured rework context.
- Review iterations are bounded; exhaustion escalates to `NEEDS_USER`.
- Dependency success in Phase 7 is `APPROVED`.
- All-approved terminal state is `READY_FOR_INTEGRATION`, not `MERGED`/`VERIFIED`.
- A lost Reviewer run is abandoned and retried with a fresh review identity; reviewer replacement does not consume a review iteration.

## Consequences

Benefits:

- Worker self-report cannot directly unlock downstream tasks;
- authors cannot self-approve;
- review decisions are auditable and idempotent;
- rework preserves previous artifact provenance;
- transient Reviewer tab failure does not confuse old/new review responses;
- a small agent pool can dynamically allocate review capacity without a permanent extra role.

Costs:

- review consumes Worker capacity;
- `maxWorkers=1` still requires two connected Worker tabs for independence;
- LLM review remains probabilistic, so deterministic payload validation can validate the contract but cannot prove semantic correctness;
- approved branches are still isolated and may not compose semantically until Phase 8 integration.

## Alternatives considered

### Let the Worker emit APPROVED

Rejected. It provides no independent check and violates the target state machine.

### Permanent Reviewer tab

Rejected for alpha. It wastes capacity when no review is pending and hard-codes topology instead of dynamic role allocation.

### Unlock dependencies at Git-valid DONE and review later

Rejected. It allows an acceptance-criterion defect to propagate before the quality gate runs.

### Reuse the same reviewId after Reviewer loss

Rejected. A late response from the abandoned Reviewer could collide with the replacement review identity. Fresh review IDs provide deterministic stale-event rejection.
