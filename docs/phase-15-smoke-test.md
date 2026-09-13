# Phase 15 Desktop Shell Smoke Test

## Automated gate

Run on Node 22:

```bash
npm run test:phase15
```

Expected: NodeTimerRuntime contract tests, desktop data-path creation, portable IPC routing and DesktopHost/Core bootstrap all pass.

## Manual desktop shell

```bash
npm install
npm run desktop:dev
```

Verify:

1. the Electron window opens the shared Orchestra Dashboard;
2. Dashboard polling returns Orchestrator API v4 data;
3. a synthetic Lead is visible from FakeAgentRuntime;
4. persistence reports the `sqlite` backend;
5. `<userData>/state/orchestra.sqlite` is created;
6. `<userData>/logs/orchestra.jsonl` contains `desktop_host_starting` and `desktop_host_ready` records;
7. pause/resume controls return portable API responses and the renderer has no Node globals;
8. closing and reopening the app reuses the same SQLite database.

## Packaging smoke

```bash
npm run desktop:pack
```

Launch the unpacked artifact from `dist/desktop/` on the current OS and repeat the Dashboard/persistence checks.

Phase 16 browser-companion connectivity and Phase 17 real local Git/worktree execution are explicitly outside this smoke test.
