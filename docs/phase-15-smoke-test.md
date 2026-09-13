# Phase 15 Desktop Shell Smoke Test

## Automated gate

Run on Node 22:

```bash
npm run test:phase15
```

Expected coverage:

- `NodeTimerRuntime` contract behavior and contained timer-listener failures;
- platform-specific desktop data directories;
- portable `query` / `execute` IPC routing;
- `DesktopHost` composition against the real portable Core;
- real SQLite persistence across host close/reopen;
- deterministic synthetic planning through all six planning stages;
- two independent fake workers dispatched in parallel with a dependent task held back;
- pause to a safe point while completed worker runs remain queued for review;
- process-style restart on the same SQLite database;
- resume with recreated/ready fake workers, review approvals, dependent-task dispatch and verified integration;
- Dashboard observability from the reopened host and portable Project Bundle export without browser session identities.

The synthetic E2E uses the real Planning, Scheduler, Review, Integration, Recovery, Orchestrator API and SQLite paths. Only agent responses and Git provenance are deterministic fixtures; the extension-companion transport and local Git/worktree runtime remain later phases.

## Manual desktop shell

```bash
npm install
npm run desktop:dev
```

Verify:

1. the Electron window opens the shared Orchestra Dashboard;
2. Dashboard polling returns Orchestrator API v4 data;
3. a synthetic Lead is visible from `FakeAgentRuntime`;
4. persistence reports the `sqlite` backend;
5. `<userData>/state/orchestra.sqlite` is created;
6. `<userData>/logs/orchestra.jsonl` contains `desktop_host_starting` and `desktop_host_ready` records;
7. starting execution with the fake runtime settles created workers to `IDLE` and allows Scheduler dispatch;
8. pause/resume controls return portable API responses and the renderer has no Node globals;
9. closing and reopening the app reuses the same SQLite database and recovery state.

## Packaging smoke

```bash
npm run desktop:pack
```

Launch the unpacked artifact from `dist/desktop/` on the current OS and repeat the Dashboard/persistence checks.

Phase 16 browser-companion connectivity and Phase 17 real local Git/worktree execution are explicitly outside this smoke test.
