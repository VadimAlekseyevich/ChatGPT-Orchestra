# 0004 — Conflict-aware scheduler and interim completion policy

Status: Accepted
Date: 2026-09-12

## Context

Phase 4 produces a validated task DAG, but several tasks may be theoretically dependency-independent while still contending for the same files, schemas, generated artifacts or shared configuration. Dispatching every dependency-independent task immediately would maximize tab count rather than useful parallelism and would move conflict handling into later phases.

Phase 5 also precedes Git isolation and independent review. A Worker can report that its task is complete, but Orchestra cannot yet honestly call that work merged or verified.

## Decision

Phase 5 uses a persisted central scheduler with the following rules:

1. scheduling state is separate from the immutable approved task graph;
2. a runnable task requires satisfied dependencies, a free Worker slot and no mutually-exclusive conflict with active tasks;
3. file-scope overlap and resource locks are conservative exclusion signals;
4. candidate ordering prefers downstream-unblocking value, then business priority, then lower risk;
5. Worker assignments are bound to exact `projectId/taskId/runId/agentId` protocol context;
6. retries and watchdog outcomes create new runs rather than mutating run identity;
7. Worker `DONE` becomes `DONE_UNVERIFIED` in Phase 5;
8. `DONE_UNVERIFIED` is temporarily accepted as dependency-success so scheduler behavior can be exercised before Phase 7 review exists;
9. no Phase 5 code may emit `APPROVED`, `MERGED` or `VERIFIED`;
10. scheduler decisions are persisted for audit/debugging.

## Consequences

Positive:

- conflict prevention is part of scheduling rather than a later emergency mechanism;
- task/run attempts are recoverable and auditable;
- parallelism is configurable and deterministic;
- scheduler can be tested independently from Git/review systems;
- Phase 7 can tighten dependency-success semantics without replacing the scheduler architecture.

Costs:

- file-prefix conflict detection is intentionally conservative and may reduce parallelism;
- `DONE_UNVERIFIED` is a transitional status requiring explicit migration in later phases;
- resource-lock inference cannot understand every semantic conflict;
- full pause/resume and user resolution remain deferred to Phase 9.

## Alternatives considered

### Dispatch every dependency-independent task

Rejected because it optimizes visible concurrency while increasing predictable file/schema conflicts.

### Treat Worker DONE as VERIFIED

Rejected because Phase 5 has neither independent review nor Git artifact verification.

### Wait for Phase 7 before unlocking any dependency

Rejected because Phase 5 could not satisfy its own scheduler acceptance tests. The temporary `DONE_UNVERIFIED` dependency policy is explicit and isolated so it can be replaced later.

### Keep task state only in chat transcripts

Rejected because tabs are replaceable executors and cannot be the source of truth.
