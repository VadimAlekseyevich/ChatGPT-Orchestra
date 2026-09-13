# Phase 8 Smoke Test

## Node regression gate

From a fresh checkout:

```bash
npm test
npm run test:phase8
```

Phase 8 suite covers:

- deterministic DAG-aware merge order;
- approved artifact provenance preflight;
- privileged integration protocol context;
- persisted integration/repair state;
- dynamic Integrator allocation;
- exact remote branch/head validation;
- approved commit ancestry;
- first-parent merge-order verification;
- text conflict -> repair turn;
- semantic conflict attribution;
- ambiguous MV3 restart fail-safe;
- project lifecycle to `INTEGRATION_VERIFIED`.

## Edge happy-path smoke test

Use a disposable public GitHub repository and at least two independent code tasks plus a dependent consumer.

1. Reload the unpacked extension.
2. Register Lead and create enough Worker tabs for execution/review.
3. Run planning and execution until every task is `APPROVED`.
4. Confirm project reaches `READY_FOR_INTEGRATION`.
5. Orchestra should automatically allocate an idle Worker as Integrator.
6. Inspect the Integrator prompt:
   - integration branch is `orchestra/<project>/integration/<run>`;
   - immutable base SHA equals the Phase 6 snapshot;
   - task branches are listed in deterministic order;
   - prompt requires `git merge --no-ff --no-edit`;
   - direct target-branch write is forbidden.
7. Let Integrator finish and push only the integration branch.
8. Expected final project status: `INTEGRATION_VERIFIED`.
9. Verify the target branch SHA did not change.
10. Verify popup shows the integration branch and short integration head SHA.

## Text conflict acceptance scenario

Prepare two reviewed task branches that modify the same lines so the second `--no-ff` merge conflicts.

Expected behavior:

1. Integrator emits `CONFLICT` with `conflictType=text`.
2. `mergedTaskIds` is the clean prefix before the conflicting task.
3. `currentTaskId` identifies the branch being merged.
4. conflict files are reported.
5. Orchestra identifies responsible upstream tasks using conflict files + artifact ownership.
6. a persisted `integration-repair-*` task is created.
7. the same Integrator receives a second bounded repair prompt with sequence+1.
8. after safe resolution, remaining branches are merged and all integration checks rerun.
9. only a remotely verified final branch may become `INTEGRATION_VERIFIED`.

Negative checks:

- wrong merged prefix -> `NEEDS_USER`;
- conflict file list missing -> `NEEDS_USER`;
- repair budget exhausted -> `NEEDS_USER`;
- target branch moved -> `NEEDS_USER`.

## Semantic conflict acceptance scenario

Create two task branches that merge cleanly but jointly break an integration test.

Expected behavior:

1. all Git merges succeed;
2. integration verification fails;
3. Integrator emits `CONFLICT` with `conflictType=semantic`;
4. failed command + evidence are present;
5. explicit `responsibleTaskIds` are present;
6. Orchestra creates a bounded repair task;
7. repair changes only files already present in approved task artifact file union;
8. all integration checks rerun;
9. final `DONE` is rejected unless every required check reports PASS evidence.

A semantic conflict without explicit responsible task attribution must fail closed rather than guessing responsibility.

## Remote-verification negative tests

Try each independently:

- report an integration commit that is not the remote branch head;
- omit one approved task branch from the merge;
- merge task branches in a different order;
- squash or cherry-pick instead of `--no-ff` merge;
- report changedFiles that differ from GitHub compare;
- modify a file no approved task artifact changed;
- move target branch after execution base snapshot.

None of these may produce `INTEGRATION_VERIFIED`.

## Restart-window smoke

During Integrator dispatch, force a service-worker restart around prompt delivery. An ambiguous persisted `ASSIGNED` integration run must be abandoned and replaced with a new run/branch identity instead of replaying the old prompt. Late output from the old run must be rejected by the new protocol context.

Full browser/project Resume semantics are intentionally Phase 9.
