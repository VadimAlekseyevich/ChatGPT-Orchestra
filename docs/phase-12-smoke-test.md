# Phase 12 Smoke Test — Portable Dashboard + Observability API

## Node gate

```powershell
git pull
npm test
npm run test:phase12
```

`test:phase12` validates the portable observability DTO, task-control safety, generic API v3 transport, Dashboard frontend with Fake API, platform boundaries and Phase 11 persistence compatibility.

## Standalone Dashboard gate

Open `dashboard/standalone.html` through a simple local static server (or another normal browser host that allows local scripts).

Expected:

- Dashboard renders project/task/agent/review/integration fixture data;
- no extension installation is required;
- Pause/Resume and task controls mutate the Fake API fixture;
- no `chrome.runtime` dependency is used;
- the same `dashboard/dashboard-app.js` file is used by the extension popup.

## Edge extension gate

1. Reload ChatGPT Orchestra at `edge://extensions/`.
2. Refresh open ChatGPT agent tabs.
3. Open the popup.
4. Verify **Portable Dashboard** renders even before execution.
5. Start or restore a test project.
6. Verify project/repository/base/recovery data.
7. During execution verify:
   - DAG/task states update;
   - active Worker run appears;
   - Agent health reflects IDLE/BUSY/OFFLINE;
   - event timeline receives protocol events;
   - scheduler decisions explain dispatch/defer/retry;
   - Git artifact appears after Worker completion;
   - Review evidence appears after review;
   - Integration evidence appears after integration.
8. Trigger a safe `NEEDS_USER` fixture and use Retry; verify the task returns to scheduling through Core state machines.
9. Change priority for an inactive task.
10. Reassign an eligible task to an idle Worker.
11. Attempt to cancel a task with downstream dependencies; Dashboard must require explicit cascade confirmation rather than silently orphaning downstream tasks.
12. Verify Pause / Resume / Stop Now still behave exactly like Phase 9.
13. Click Open on an agent; Edge should activate the corresponding ChatGPT executor through the extension host adapter.
14. Export Project Bundle and Debug Bundle.

## Portability checks

Inspect the response of `dashboard` API or exported debug bundle. It must not contain:

```text
tabId
legacyTabId
sessionId
runtimeSource
```

Logical `agentId`, task/run/review/integration IDs and Git branch/commit provenance are expected.

## Negative checks

- active RUNNING task cannot be silently cancelled by task-control API;
- retry is rejected unless task is inactive `NEEDS_USER`;
- manual reassign is rejected for offline/busy Worker or unsatisfied dependencies;
- agent-session sender cannot issue privileged generic API commands;
- unknown API query/command fails closed;
- Dashboard source does not directly access Chrome storage/tabs, SQLite or internal stores.
