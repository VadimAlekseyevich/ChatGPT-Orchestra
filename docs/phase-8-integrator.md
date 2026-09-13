# Phase 8 — Integrator + Semantic Conflicts

Phase 8 turns individually `APPROVED` task branches into one independently verifiable integration result without writing the target branch.

## Lifecycle

```text
all tasks APPROVED
      |
      v
READY_FOR_INTEGRATION
      |
      v
Integrator allocation
      |
      v
orchestra/<projectId>/integration/<runId>
      |
      v
deterministic --no-ff merges
      |
      +--> CONFLICT(text) ----> repair task ----+
      |                                        |
      +--> integration checks                  |
              |                                |
              +--> CONFLICT(semantic) -> repair+
              |
              v
            DONE
              |
              v
remote branch/head/ancestry/history validation
              |
              v
INTEGRATION_VERIFIED
```

## Dynamic Integrator role

Integrator is not a permanent fifth tab. `IntegrationEngine` allocates an idle registered Worker after Phase 7 reaches `READY_FOR_INTEGRATION`. Candidates with fewer authored task runs are preferred, but authorship does not disqualify an Integrator because task acceptance already happened through an independent Reviewer.

The Integrator gets a dedicated protocol context:

```text
projectId = project
 taskId   = integration
 runId    = integration-<uuid>
```

Integration `DONE`/`CONFLICT` events are privileged: Event Bus requires an exact bound protocol context before reserving the event ID.

## Integration branch

Every attempt uses a unique branch:

```text
orchestra/<projectId>/integration/<integrationRunId>
```

The branch starts at the immutable Phase 6 base SHA. The target branch must still point to that SHA both before dispatch and before final acceptance.

### Target policy

Alpha.9 policy is fixed to:

```text
integration_branch_only
```

The Integrator never pushes or merges directly to the target branch. `INTEGRATION_VERIFIED` means a verified composition exists on the integration branch; it does not mean the target branch changed.

## Deterministic merge order

Order is derived from the approved DAG, never Worker completion time.

1. Dependencies always come before consumers.
2. Among simultaneously runnable tasks, foundational schema/API/protocol/core work is preferred.
3. Ordinary implementation follows.
4. Isolated tests/docs are later where dependencies permit.
5. Priority and task ID provide deterministic tie-breaking.

Only task artifacts with canonical Git provenance are mergeable. An `APPROVED` mutating task without `lastArtifact.branch` + `lastArtifact.commit` fails closed before Integrator dispatch.

## Why merge commits, not cherry-pick

Integrator must use:

```bash
git merge --no-ff --no-edit <task-branch>
```

and must not squash, rebase or cherry-pick reviewed task commits.

This preserves every approved task commit as an ancestor of the integration head. The service worker later verifies:

- integration branch remote head equals the reported full SHA;
- merge base equals the immutable project base;
- target branch is still unchanged;
- every approved task commit is an ancestor of integration head;
- first-parent merge commits contain task tips in the expected order;
- base-to-integration changed files are a subset of the already approved task artifact files;
- Integrator-reported changedFiles exactly match GitHub compare;
- every required integration verification command has `PASS` evidence.

## Text conflicts

On a Git text conflict the Integrator must:

1. record unresolved files;
2. report the successfully merged prefix and current task;
3. run `git merge --abort`;
4. emit `CONFLICT` with `conflictType=text`.

The orchestrator attributes responsibility using:

- explicit responsible task IDs;
- current task;
- approved artifacts that touched the conflicted files.

It persists a bounded integration repair task and sends a repair turn to the same Integrator. The repair turn re-runs the conflicting merge, resolves only conflict files according to approved intent, continues deterministic merges, reruns all integration checks, and either emits `DONE` or another `CONFLICT`.

## Semantic conflicts

A semantic conflict is a clean Git composition where integration verification fails because approved changes are incompatible.

`CONFLICT` must contain:

- `conflictType=semantic`;
- failed checks with evidence;
- explicit `responsibleTaskIds`.

Semantic responsibility is never guessed from a failed test name alone. Missing explicit attribution fails closed to `NEEDS_USER`.

A bounded repair task may make the smallest compatibility change on the integration branch, but it may not modify files outside the union of approved task artifact files. All integration checks run again after repair.

## Repair budget

Default repair budget is 2 per integration run. Repeated conflict beyond the budget becomes `NEEDS_USER` rather than an unbounded LLM loop.

Integration dispatch attempts also use fresh run/branch identities. Ambiguous MV3 restart windows (`ASSIGNED` or `REPAIR_PENDING`) are abandoned rather than replayed; a new run is created so a late old event cannot act on the new protocol context.

Full project-wide Pause/Resume reconciliation remains Phase 9.

## Completion state

Successful Phase 8 stores an integration summary containing:

- integration branch;
- integration head SHA;
- immutable base SHA;
- target branch;
- deterministic task merge order;
- changed files;
- integration check evidence;
- independently verified task commit ancestry;
- first-parent merge order;
- target policy.

The terminal Phase 8 project state is:

```text
INTEGRATION_VERIFIED
```

not `MERGED` and not a direct target-branch side effect.
