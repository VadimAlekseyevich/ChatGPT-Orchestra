# Phase 4 — Local Smoke Test

Run this before relying on `2.0.0-alpha.5` for a real project.

## Node regression suite

```powershell
npm test
npm run test:phase4
```

Both commands must exit successfully.

## Edge extension smoke test

1. Pull the latest `main` and reload the unpacked extension in `edge://extensions/`.
2. Refresh the ChatGPT tab used as Lead.
3. Open the Orchestra popup and register that tab with **Эту вкладку → Lead**.
4. Enter an HTTPS GitHub root URL, for example `https://github.com/owner/repo`.
5. Enter a sufficiently detailed project goal.
6. Press **Start Planning**.
7. Verify the popup advances through planning stages rather than creating worker assignments:
   - `DISCOVERY`
   - `PLAN_V1`
   - `CRITIQUE`
   - `PLAN_V2`
   - `DECOMPOSE`
   - `DAG_CRITIC`
   - `READY`
8. The final project status must show a non-zero task count and a successful validation result.
9. Confirm no Worker receives a DAG task automatically; that begins in Phase 5.

## Failure checks

- invalid/non-GitHub repository URL must be rejected;
- a second project must not start while the first is actively planning;
- if Lead reports repository access as unavailable, project must stop in `NEEDS_USER` instead of fabricating a plan;
- malformed/missing planning artifact markers must not advance the project;
- a stale response from an earlier stage/run must be rejected by protocol context;
- legacy `DONE` behavior should still work in an unrelated normal ChatGPT tab when enabled.

## Restart recovery check

During a long planning stage, reload the extension/service worker and then let the Lead finish. The persisted project/run context should still accept the current response. If an accepted stage event had already been persisted before the service-worker interruption, Orchestra should advance from that event without replaying the already processed event side effect.

Full browser/project crash reconciliation remains Phase 9; this check covers only the Phase 4 planning recovery guarantees.
