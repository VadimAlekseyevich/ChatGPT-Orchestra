# Phase 10 Smoke Test — Platform Boundary

## Node gate

```powershell
git pull
npm test
npm run test:phase10
```

Phase 10-specific checks must prove:

- `MemoryStateStore`, `FakeAgentRuntime` and deterministic timer satisfy contracts;
- FakeAgentRuntime works with no `globalThis.chrome`;
- EventBus accepts logical runtime sender identity and preserves idempotency;
- Orchestrator API aggregates public state and maps legacy extension transport;
- portable orchestration boundary contains no direct `chrome.*` references;
- existing Planning/Scheduler/Review/Integration/Recovery regressions still pass.

## Edge regression smoke

Reload the unpacked extension after pulling alpha.11.

1. Register the active ChatGPT tab as Lead.
2. Create at least two Workers.
3. Confirm prompts still target the selected Worker only.
4. Start a small planning project and verify planning advances through its existing stages.
5. Start execution and verify Worker → Git validation → Review behavior is unchanged.
6. Exercise `Pause`, then `Resume`.
7. Exercise `Stop Now` on disposable work and verify interrupted work is not accepted as completion.
8. Close/reload one Worker tab and confirm recovery semantics remain unchanged.

Expected result: no user-visible orchestration behavior change relative to alpha.10 except the prerelease version.

## API smoke

From Node tests or a debug harness, call `OrchestratorApi` directly rather than Chrome messages:

```js
await api.query("state")
await api.execute("createWorkers", { count: 2 })
await api.execute("pause")
```

Responses must include:

```json
{
  "apiVersion": 1,
  "ok": true
}
```

A sender identified as an agent/browser session must not be able to invoke privileged admin commands through the legacy transport mapping.

## Negative boundary check

Adding direct `chrome.tabs`, `chrome.storage` or `chrome.alarms` access to Scheduler/Review/Integration/Recovery/Orchestrator modules must make `tests/platform-boundary.test.js` fail.

## Phase boundary

This smoke test does not require Electron, SQLite, Playwright or Project Bundle migration. Those begin in later phases.
