# Phase 9 smoke test — Pause / Resume / Crash Recovery

## Local test gate

```powershell
git pull
npm test
npm run test:phase9
```

## Setup

Use a disposable public GitHub repository. Prepare a project whose validated DAG has at least three independent mutating tasks and one downstream task. Register a Lead and create at least three Worker tabs.

Start execution with `maxWorkers=3` and confirm that three Worker runs are active.

## Scenario A — graceful Pause

1. While at least one Worker is generating, click **Pause**.
2. Expected immediately:
   - recovery status = `PAUSING`;
   - no new Worker/Reviewer/Integrator prompt is sent.
3. Let current generations finish naturally.
4. Their accepted protocol events / Git artifacts may still persist.
5. After the last active generation is gone, expected:
   - recovery status = `PAUSED`;
   - safe point reports no active Worker/Review/Integration generation.
6. Wait at least one watchdog interval.
7. Verify no new assignment appeared while paused.
8. Click **Resume**.
9. Expected:
   - `RECOVERING` briefly;
   - Git/base/context reconciliation;
   - `RUNNING` only after reconciliation;
   - queued work resumes without duplicate assignment of already completed/approved tasks.

## Scenario B — Stop Now

1. Start fresh active Worker work.
2. Click **Stop Now** while responses are still generating.
3. Expected:
   - recovery status passes through `STOPPING` to `STOPPED`;
   - active ChatGPT generations receive best-effort stop command;
   - active Worker run is `INTERRUPTED`, never completion;
   - task becomes eligible for a fresh run after Resume;
   - active Review is requeued with a fresh review ID;
   - active Integration run is abandoned, not reused.
4. If a stopped ChatGPT response still emits a late `DONE`, confirm it does not change task state to completed. Event audit may contain the event, but state machine must ignore it across the Stop boundary.
5. Click **Resume** and verify fresh run identities are used.

## Scenario C — full browser restart

1. Start a project with at least three active Workers.
2. Let one Worker push partial progress to its assigned task branch, but do not let it finish its Orchestra `DONE` event.
3. Force-close Edge completely.
4. Reopen Edge and reload the unpacked extension if needed.
5. Open the Orchestra popup.
6. Expected before explicit Resume when original tabs are gone:
   - recovery status = `RECOVERY_REQUIRED`;
   - no new prompts dispatched automatically.
7. If planning was active, reconnect/register Lead as needed.
8. Click **Resume**.
9. Expected:
   - known tabs reconciled;
   - missing Worker identities are replaced with fresh agent IDs;
   - target branch is checked against captured base SHA;
   - missing/unchanged task branches become interrupted work with fresh runs;
   - safe partial Git progress is scope-validated and becomes the `startSha` context for a fresh run;
   - unsafe/out-of-scope progress leaves project in `RECOVERY_REQUIRED`;
   - reviews/integration use fresh identities if their original tabs disappeared;
   - protocol contexts match only current active identities.
10. Continue project to `INTEGRATION_VERIFIED`.

## Scenario D — MV3 service-worker restart with tabs alive

1. Keep active Worker tabs open.
2. Trigger service-worker restart from `edge://extensions/` without closing those ChatGPT tabs.
3. Expected:
   - dispatch remains closed during boot reconciliation;
   - existing live run identities/context are reconciled;
   - Orchestra returns to `RUNNING` automatically;
   - the already-active task is not assigned a second time.

## Negative checks

- Move the target branch before Resume: recovery must fail closed with target/base freshness issue.
- Put an out-of-scope file on a lost Worker's task branch: recovery must not adopt that commit.
- Close Reviewer tab: replacement review must receive a fresh `reviewId`.
- Close Integrator tab: the old integration run/branch must not be treated as current; a fresh integration identity is required.
- While `PAUSED` or `RECOVERY_REQUIRED`, wait for heartbeats/watchdog events and verify they do not cause new prompts.

## Acceptance

Phase 9 passes manual smoke acceptance when a three-Worker project can survive browser closure and explicit Resume without duplicate task assignment, duplicate review/integration side effects, stale protocol-context acceptance, or unverified adoption of Git progress.
