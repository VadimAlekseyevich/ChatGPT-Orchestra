# Phase 7 — Independent Review Loop

Phase 7 separates Worker completion from acceptance. A Worker can produce a valid Git artifact, but that artifact does not unlock dependent tasks until a different registered agent reviews it against the task contract.

## State flow

```text
READY
  ↓
ASSIGNED / RUNNING
  ↓
DONE_BY_WORKER
  ↓
REVIEW_PENDING
  ↓
REVIEWING
  ├─ REVIEW_APPROVED ─→ APPROVED
  └─ CHANGES_REQUIRED ─→ READY (rework)
                              ↓
                         new Worker run
```

When every task is `APPROVED`, the scheduler/project becomes:

```text
READY_FOR_INTEGRATION
```

This is not `MERGED` or `VERIFIED`. Phase 8 owns integration, merge ordering and semantic-conflict handling.

## Dynamic Reviewer role

Reviewer is not a permanent fifth tab. Any idle registered Worker may temporarily act as Reviewer if:

- it owns no active Worker run;
- it owns no other active review;
- it is not the author of the Worker run being reviewed;
- its tab is connected and `IDLE`.

Author and Reviewer identity must differ. This invariant is enforced both before assignment and when review events are accepted.

Optional future/specialized selection is already represented by `task.reviewerCapabilities` and `agent.capabilities`: candidates matching more requested capabilities sort first. The base alpha does not require capabilities to be configured.

If execution concurrency is `maxWorkers=1`, Orchestra still keeps at least two connected Worker tabs so one can author and another can review. The scheduler concurrency budget remains one active role at a time.

## Review identity and idempotency

Every review has its own `reviewId`. Protocol binding uses:

```text
projectId = project
 taskId   = reviewed task
 runId    = reviewId
 agentId  = reviewer
```

A lost/replaced Reviewer run is never reused. The old review becomes `ABANDONED`, and retry receives a fresh `reviewId` with `retryOf` provenance. This prevents a late stale answer from an abandoned Reviewer from being confused with a new review attempt.

## Review packet

Reviewer receives only bounded task context, never the full Worker chat history:

- task definition;
- acceptance criteria;
- relevant architecture/repository rules extracted from persisted planning artifacts;
- Worker summary;
- Worker test evidence;
- known limitations;
- independently validated Git artifact;
- bounded provider-derived diff summary/patches;
- task scope and verification commands;
- review iteration/provenance.

Git provenance is evidence that the artifact exists and stayed within Phase 6 scope. It is not proof that the implementation satisfies acceptance criteria.

## Structured verdict

`REVIEW_APPROVED` requires:

- an entry for every acceptance criterion using the exact criterion text;
- every criterion `PASS` with evidence;
- `scopeCheck.status = PASS` with evidence;
- `testsAssessment.status = PASS | WAIVED` with evidence;
- no blocking/high/critical issue;
- no required changes.

`CHANGES_REQUIRED` requires:

- at least one concrete failure/finding; and
- non-empty `requiredChanges`.

Review issues are structured:

```json
{
  "severity": "high",
  "code": "AC_MISSING",
  "message": "Invalid input is still accepted",
  "evidence": "Observed in reviewed diff/test evidence",
  "file": "src/example.js",
  "suggestion": "Reject invalid input before mutation"
}
```

Malformed or incomplete approval fails closed and escalates to `NEEDS_USER`; it does not silently approve a task.

## Rework runs

`CHANGES_REQUIRED` returns the task to `READY` when review budget remains.

A rework run:

- gets a new `runId`;
- gets a new unique `orchestra/<project>/<task>/<run>` branch;
- receives structured Reviewer issues and `requiredChanges`;
- for mutating tasks starts from the previous reviewed artifact commit;
- still validates against the immutable project execution base through the Phase 6 Git provider.

The old run, artifact and review remain in history.

## Review iteration budget

Default maximum review iterations: `3`.

Iteration increments when a new Worker result is submitted for review, not when a Reviewer tab is merely replaced. Therefore transient Reviewer loss does not consume the quality-loop budget.

If `CHANGES_REQUIRED` is returned at the configured limit, the task/scheduler/project transition to `NEEDS_USER` instead of cycling indefinitely.

## Dependency policy in Phase 7

A dependency is satisfied only when the upstream task status is:

```text
APPROVED
```

Ordinary Worker `DONE`, validated Git artifact, `DONE_BY_WORKER`, `REVIEW_PENDING` and `REVIEWING` cannot unlock downstream work.

This is a Phase 7 acceptance policy. It still does not mean the approved branch has been integrated into another task branch. Cross-branch semantic dependency handling belongs to Phase 8 Integrator.

## Persistence and upgrade behavior

Review state is persisted independently in `orchestra.reviews.v1`.

When upgrading from alpha.7:

- old `DONE_UNVERIFIED` with canonical Git artifact becomes `DONE_BY_WORKER` and must enter review;
- old mutating completion without Git provenance becomes `NEEDS_USER`;
- old scheduler `COMPLETED_UNVERIFIED` re-enters `RUNNING` until all tasks pass review.

No previous self-reported completion is upgraded directly to `APPROVED`.

## Phase boundary

Phase 7 does not:

- merge/rebase/cherry-pick branches;
- create an integration branch;
- classify semantic integration failures;
- write to the target branch;
- mark the project `MERGED` or `VERIFIED`.

Those are Phase 8 responsibilities.
