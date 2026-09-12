# Phase 5 — Scheduler + Parallel Workers

Phase 5 turns the validated Phase 4 task graph into persisted task/run execution state and dispatches runnable work to registered Worker tabs.

## Boundary

Phase 5 implements scheduling only. It does **not** implement Git task branches, artifact validation, review approval, integration or merge. Those remain Phase 6–8.

For that reason Worker `DONE` is stored as:

```text
DONE_UNVERIFIED
```

It is sufficient for dependency unlocking in alpha.6, but it must never be presented as `APPROVED`, `MERGED` or `VERIFIED`.

## Persisted scheduler state

`SchedulerStore` uses `chrome.storage.local` under `orchestra.scheduler.v1` and stores:

- `projectId` and scheduler status;
- settings (`maxWorkers`, retry budget, timeout);
- mutable task states;
- run history and active assignments;
- acquired/inferred resource locks;
- bounded scheduler decision log.

The approved Phase 4 `taskGraph` remains immutable planning input. Mutable execution state is not written back into that graph.

## Task/run flow

Phase 5 task states used by the runtime are:

```text
READY
  -> ASSIGNED
  -> RUNNING (optional explicit TASK_ACCEPTED/PROGRESS)
  -> DONE_UNVERIFIED

ASSIGNED/RUNNING
  -> retryable BLOCKED/ERROR/TIMEOUT -> READY
  -> non-retryable / retry exhausted -> NEEDS_USER
```

A task can have multiple runs. `runId`, not `taskId`, identifies one execution attempt.

## Runnable rule

A task is runnable when:

```text
task.status == READY
AND every dependency.status == DONE_UNVERIFIED   # temporary Phase 5 policy
AND no active mutually-exclusive task conflicts with it
AND scheduler.status == RUNNING
AND a Worker slot is available
```

Phase 7 will replace the temporary dependency-success policy with review/verification-aware semantics.

## Candidate ordering

Scheduler v1 orders runnable candidates by:

1. number of downstream tasks they unblock;
2. task priority;
3. lower risk;
4. stable task id ordering.

It then rejects candidates that conflict with tasks already running in the current wave.

## Conflict prevention

`conflict-policy.js` implements conservative MVP conflict prevention.

Two tasks are mutually exclusive when either condition is true:

- their allowed file-scope prefixes overlap;
- they share an explicit or inferred exclusive resource lock.

Inferred shared resources include high-risk shared contracts plus common schema/migration and config/manifest surfaces. Tasks may also declare explicit `resourceLocks`.

Every conflict deferral is written to the scheduler decision log.

## Worker availability

A Worker is available only when:

- role is `worker`;
- it has a live `tabId`;
- registry status is `IDLE`;
- no active scheduler run already owns that `agentId`.

`maxWorkers` is persisted and configurable from 1–4 in the current browser alpha.

## Assignment protocol

Before sending a task prompt the scheduler:

1. persists a new run as `ASSIGNED`;
2. binds exact `projectId/taskId/runId` protocol context to the Worker;
3. sends the versioned Worker prompt to that specific `agentId`.

A dispatch failure is treated as a failed run and consumes retry budget. The prompt forbids claiming review/merge states and forbids unsafe direct pushes to the target branch before Phase 6 isolation exists.

The expected one-shot final event uses deterministic per-run identity:

```text
@@ORCH {"v":1,"event":"DONE","projectId":"...","taskId":"...","runId":"...","agentId":"...","eventId":"<runId>-final","sequence":1,"payload":{...}}
```

## Retry and escalation

Default retry budget is 2 retries after the initial attempt.

- retryable `BLOCKED`/`ERROR` returns the task to `READY`;
- tab loss during an active run is retryable;
- a missing Worker discovered during service-worker restart is immediately treated as a failed attempt instead of waiting for timeout;
- explicit `NEEDS_USER`, non-retryable failure, or exhausted retries moves the task and scheduler to `NEEDS_USER`.

Phase 5 deliberately does not implement a general user-resolution/resume workflow; that belongs to Phase 9.

## Watchdog

Manifest permission `alarms` drives a one-minute MV3 watchdog wake-up. A run is timed out only when there has been no recent activity for the configured timeout (20 minutes by default).

Activity considers both scheduler/protocol timestamps and `TabRegistry.lastSeenAt`, so a Worker that is still generating and sending normal content heartbeats is not falsely timed out.

## Completion

When every task is `DONE_UNVERIFIED` (or cancelled), scheduler/project status becomes:

```text
COMPLETED_UNVERIFIED
```

This means scheduling finished. It does not mean the repository result is accepted.

## Tests

`npm run test:phase5` covers:

- three parallel independent tasks;
- dependent fourth-task unlocking;
- overlapping scope exclusion;
- explicit/inferred resource locks;
- persisted run/task transitions;
- retry exhaustion;
- watchdog timeout;
- heartbeat-aware watchdog behavior;
- active-run recovery when a Worker disappeared.
