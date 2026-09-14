# Phase 15 — Desktop Shell Bootstrap

Phase 15 starts the desktop host without moving orchestration policy out of the portable Core. The Edge extension remains the production executor host; the desktop process is a second composition root that exercises the same stores, engines, recovery controller, Orchestrator API and Dashboard contracts.

## Architecture

The desktop bootstrap lives under `apps/desktop/` and has three boundaries:

1. **Main process / Core host** — `DesktopHost` composes the existing Core with `SQLiteStateStore`, `NodeTimerRuntime` and `FakeAgentRuntime`.
2. **IPC boundary** — renderer requests are only `{name, payload}` Orchestrator API calls and responses are JSON-cloned portable DTOs. Electron objects, BrowserWindow instances and Node handles never enter Core DTOs.
3. **Renderer** — the existing `DashboardApp` is reused unchanged through `DesktopDashboardTransport`.

The extension service worker remains untouched and continues to compose the same Core with Chrome storage, tabs and alarms.

## Persistence and recovery

The default desktop state database is `<userData>/state/orchestra.sqlite`. Logs are JSONL in `<userData>/logs/orchestra.jsonl`; project-bundle workspace is `<userData>/bundles/`.

Desktop boot follows the same recovery order as the extension:

`context packets → prepareForBoot → orchestrator init → integration init → afterRuntimeInit`

A one-minute Node watchdog then calls Scheduler, Integration and Recovery ticks. `FakeAgentRuntime` seeds a synthetic Lead for Phase 15 development. Workers created by the desktop fake host are deterministically settled from `CONNECTING` to `IDLE` after start/resume so the real Scheduler, Review and Integration engines can be exercised without a browser content script. Browser/extension agent bridging remains Phase 16.

The Phase 15 Node 22 gate contains a restart E2E that drives the real Core through planning, a two-worker parallel DAG, pause-to-safe-point, SQLite close/reopen, resume, review, dependent-task dispatch, integration verification, Dashboard observability and Project Bundle export. Agent responses and Git provenance are fixtures; orchestration state transitions are not mocked.

## Electron security boundary

The renderer uses `contextIsolation: true`, `nodeIntegration: false` and a narrow preload bridge exposing only `query()` and `execute()`. Navigation away from the packaged file is blocked and new HTTPS windows are opened externally.

## Development

Node 22 runs the dedicated desktop adapter and restart-E2E suite because the real SQLite adapter uses `node:sqlite`.

```bash
npm run test:phase15
```

To launch the shell locally, install dev dependencies and run:

```bash
npm install
npm run desktop:dev
```

A directory package can be produced with:

```bash
npm run desktop:pack
```

The desktop dev dependency pins Electron `44.3.0` and electron-builder `26.15.3` for reproducible Phase 15 packaging.

## Current Phase 15 boundary

This bootstrap intentionally does not implement the Phase 16 extension-companion transport or the Phase 17 real local Git/worktree runtime. `FakeAgentRuntime` remains the executor host for this phase; Git provenance stays injectable through the existing provider boundary so Phase 15 can validate orchestration and recovery independently of Phase 17 workspace mechanics.
