# Phase 5 — Local Smoke Test

Run this before relying on `2.0.0-alpha.6` for parallel execution.

## Node regression suite

```powershell
npm test
npm run test:phase5
```

Both commands must exit successfully.

## Edge scheduler smoke test

1. Pull the latest `main` after Phase 5 is merged.
2. Reload the unpacked extension in `edge://extensions/` and refresh all registered ChatGPT tabs.
3. Register one Lead and set `Worker slots / maxWorkers` to `3`.
4. Complete Phase 4 planning until the project reaches `READY` with at least four tasks where three are mutually independent and the fourth depends on all three.
5. Press **Start Execution**.
6. Verify three Worker tabs receive three different tasks without manual prompting.
7. Verify popup shows three active runs.
8. No Worker should receive a second task while it owns an active run.
9. Finish the first two independent Worker responses with valid `DONE` events. The dependent fourth task must still not start.
10. Finish the third prerequisite. Only then may the dependent fourth task be assigned.
11. Finish the fourth task. Scheduler/project status must become `COMPLETED_UNVERIFIED`, not `VERIFIED` or `MERGED`.

## Conflict prevention check

Use or construct two runnable tasks whose `scope.allow` values overlap, for example:

```text
T1: src/auth/**
T2: src/auth/tokens/**
```

Even with two idle Workers, only one of these tasks may be active at once. The other must appear in the persisted scheduler decision log as a conflict deferral.

Repeat with two non-overlapping scopes such as `src/auth/**` and `tests/payments/**`; they should be eligible for parallel assignment.

## Failure / retry checks

- a retryable `BLOCKED` or `ERROR` should create a new run for the same task when a Worker is available;
- run identity must change on retry;
- the original failed run remains in history;
- after the configured retry budget is exhausted, task/scheduler/project become `NEEDS_USER`;
- explicit `NEEDS_USER` must stop new scheduling;
- closing an active Worker tab should fail that run and make the task retryable rather than marking it complete.

## Watchdog check

Default timeout is 20 minutes and the MV3 watchdog wakes once per minute. For automated tests use an injected shorter timeout; do not wait 20 minutes manually.

Important invariant: a long ChatGPT generation that continues sending normal content heartbeats must not be timed out. Only a run with no recent protocol activity **and** no recent registered-tab heartbeat should be considered stale.

## Safety boundary

Phase 5 Worker prompts explicitly forbid unsafe direct push/merge to the target repository branch because task branch isolation starts in Phase 6. If a Worker cannot work safely without that isolation, it should return `BLOCKED` instead of bypassing the boundary.
