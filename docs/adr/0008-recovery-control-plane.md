# 0008 — Separate recovery control plane with reconcile-before-resume

Status: Accepted

Date: 2026-09-13

## Context

ChatGPT Orchestra now has several durable execution layers: planning stage state, task/run scheduler state, independent review state, integration state, tab registry, Event Bus identity and Git provenance.

A naive Pause implementation that writes `PAUSED` into every store would destroy the distinction between the actual work state and the user's lifecycle intent. A naive Resume implementation that simply flips `PAUSED -> RUNNING` could also repeat irreversible prompts or Git actions after a browser/service-worker crash.

Browser tabs are especially ambiguous: after a full browser restart, an old logical Worker identity may no longer correspond to the ChatGPT conversation that executed a persisted run.

Stop Now has an additional crash window: the service worker can restart after `STOPPING` was persisted but before every active run was terminalized. A guard that depends only on the current lifecycle status is insufficient because boot recovery may already have moved the control plane to `RECOVERY_REQUIRED` while late protocol events from the stopped generation are still arriving.

## Decision

Introduce a separate persisted `RecoveryStore` and `RecoveryController` above existing engines.

### Control plane states

```text
IDLE
RUNNING
PAUSING
PAUSED
STOPPING
STOPPED
RECOVERING
RECOVERY_REQUIRED
```

Existing Project/Scheduler/Review/Integration stores remain sources of truth for their own domain state.

### Global dispatch gate

No new model prompt may be dispatched until recovery boot reconciliation has completed. Dispatch is permitted only when:

```text
bootReady && recovery.status in {IDLE, RUNNING}
```

The gate applies to Planner, Worker, Reviewer, Integrator and direct agent prompt routing.

### Pause

Pause is a safe-point operation. It closes new dispatch immediately, lets already-running generations finish, persists their events, and becomes `PAUSED` only after active generation identities disappear.

### Stop Now

Stop Now is an interruption boundary. Active generations receive best-effort stop commands. Active work identities are then terminalized as interrupted/requeued/abandoned as appropriate.

The boundary is persisted independently as `stopBoundaryActive`. It is set before stop commands are issued, remains active across `STOPPING`, `STOPPED`, `RECOVERING` and `RECOVERY_REQUIRED`, and is cleared only by a successful reconciled transition back to `RUNNING`.

Late state-changing events received while that boundary is active remain auditable in the Event Bus but are not applied to execution state. This remains true even if a crash occurs midway through Stop Now and the recovered lifecycle status is no longer literally `STOPPING`.

### Resume and crash recovery

Resume is reconcile-first, act-second:

1. reconcile browser tabs;
2. replace missing Worker tabs with fresh agent identities;
3. validate Git base freshness;
4. reconcile active task branches and safely salvage scoped remote progress;
5. reconcile review identities;
6. reconcile integration identity;
7. rebuild exact protocol contexts;
8. only then reopen dispatch, clear any persisted Stop Now boundary, and rebuild the runnable queue.

Unknown or unsafe state yields `RECOVERY_REQUIRED` instead of optimistic continuation.

### Worker identity after browser loss

Missing Worker registry records are removed from the live pool before replacement tabs are created. The old `agentId` remains in persisted run provenance, while replacement tabs receive fresh identities. Identity reuse must never be used as proof that an old ChatGPT generation is still running.

## Consequences

### Positive

- Pause/Resume does not corrupt domain-specific state.
- MV3 service-worker restart with live tabs can recover automatically.
- Full browser loss fails closed until explicit reconciliation.
- Git progress can be reused only after independent scope/base validation.
- Stop Now cannot accidentally accept a late Worker `DONE` as completion, including across a crash during `STOPPING`.
- Old task/review/integration run identities are not replayed into fresh tabs.

### Costs

- Recovery adds another persisted store and lifecycle state machine.
- Some Phase 9 behavior is conservative: ambiguous integration work is abandoned and rebuilt rather than guessed.
- Planning Lead cannot be recreated automatically because Lead assignment remains explicitly user-controlled.
- Recovery may require Git provider availability before work can safely continue.
- Stop boundary state must be migrated conservatively and treated as fail-closed until reconciliation succeeds.

## Alternatives considered

### Store `PAUSED` directly in Scheduler/Review/Integration stores

Rejected because lifecycle intent and work state would be conflated, making exact recovery harder and migrations brittle.

### Resume immediately and reconcile asynchronously

Rejected because new prompts could race ahead of reconciliation and create duplicate or irreversible side effects.

### Guard Stop Now only by `STOPPING/STOPPED` status

Rejected because crash recovery can change the lifecycle status before late events stop arriving. A separately persisted boundary is required to preserve the interruption contract across restart.

### Reuse old Worker `agentId` for newly created tabs

Rejected because a fresh empty ChatGPT tab is not evidence that the old run still exists, even if the extension can reuse the registry identity.

### Discard all partial Git work after crash

Rejected because independently verifiable, in-scope remote progress can be safely preserved as the starting commit for a fresh run without trusting the lost chat context.
