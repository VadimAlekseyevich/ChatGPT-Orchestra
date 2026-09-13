# Phase 12 — Portable Dashboard + Observability API

Phase 12 превращает UI Orchestra в переносимый клиент Orchestrator Core. Один и тот же `DashboardApp` работает внутри Edge extension и в standalone host с Fake Orchestrator API. Будущий desktop renderer должен использовать тот же frontend contract.

## Главный инвариант

Dashboard не читает и не изменяет напрямую:

- `chrome.storage`;
- `chrome.tabs`;
- SQLite;
- `ProjectStore`;
- `SchedulerStore`;
- `ReviewStore`;
- `IntegrationStore`;
- `RecoveryStore`.

Frontend знает только transport с двумя методами:

```js
transport.query(name, payload)
transport.execute(name, payload)
```

Extension host реализует transport через `chrome.runtime.sendMessage`; standalone host использует `FakeDashboardTransport`; desktop later сможет дать IPC transport без изменения `DashboardApp`.

## Observability read model

`background/observability-service.js` строит versioned `observabilityVersion: 1` DTO поверх внутренних stores. Это отдельный read model, а не выдача raw persisted state.

Dashboard DTO содержит:

- project goal/status/repository/base;
- scheduler status/settings/Git snapshot;
- full task list + dependency blockers;
- active/last runs and Git artifacts;
- review history/evidence;
- integration runs/conflicts/repairs/final evidence;
- recovery lifecycle/issues;
- logical agent health;
- recent scheduler decisions;
- accepted/rejected event timeline;
- warnings / `NEEDS_USER` aggregation;
- bounded local runtime metrics;
- persistence backend/schema metadata.

DTO рекурсивно удаляет browser/runtime handles (`tabId`, `legacyTabId`, `sessionId`, `runtimeSource` and browser runtime source objects). `agentId` остаётся portable logical identity.

Raw chat transcripts в observability API не выдаются.

## Orchestrator API v3

Phase 12 обновляет Orchestrator API до v3.

Новые queries:

```text
dashboard
taskGraph
taskDetails
agents
warnings
metrics
reviewDetails
integrationEvidence
```

Существующие `state`, `events`, `project`, `scheduler`, `schedulerDecisions`, `recovery`, `persistence` сохраняются.

Новые commands:

```text
retryTask
cancelTask
changePriority
reassignAgent
requestReview
startIntegration
openExecutor
exportDebugBundle
```

Существующие lifecycle/project/persistence commands сохраняются.

Extension получает generic compatibility transport messages:

```text
orchestra/api-query
orchestra/api-execute
```

Old named runtime messages остаются рабочими для backward compatibility.

## TaskControlService

Dashboard mutations не меняют store state самостоятельно. `TaskControlService` проверяет lifecycle/status invariants и делегирует существующим Scheduler/Review/Integration engines.

Safety rules:

- Retry допустим только для inactive `NEEDS_USER` task;
- Cancel допустим только для inactive `READY/NEEDS_USER` task; downstream tasks требуют explicit cascade;
- active work/review не отменяется скрытым state rewrite;
- priority меняется только у inactive tasks;
- manual reassign требует `RUNNING` recovery, satisfied dependencies, no conflict, свободную connected Worker identity и свободный concurrency slot;
- manual Review доступен только для reviewable Worker completion;
- manual Integration запускает existing Integrator state machine, а не отдельный merge path;
- Open executor использует logical `agentId`; host adapter решает, как активировать соответствующий executor.

Разрешение `NEEDS_USER` через Retry/Cancel/Reassign повторно открывает underlying execution state; RecoveryController всё равно остаётся верхним dispatch gate.

## Dashboard frontend

`dashboard/dashboard-app.js` показывает:

- project overview;
- progress metrics;
- Pause / Resume / Stop Now;
- task/DAG list and details;
- Retry / Cancel / priority / reassign / review controls;
- agent health and Open executor;
- Review evidence;
- Integration evidence/repairs;
- warning severity filter;
- event timeline;
- scheduler decision explanation;
- Project Bundle export;
- sanitized debug bundle export.

Phase 12 использует polling через API (default 3 seconds in extension). Это transport implementation detail: API DTO не зависит от polling и later может быть delivered through desktop IPC subscriptions.

## Hosts

### Extension

`dashboard/extension-transport.js` — единственный Dashboard adapter, знающий `chrome.runtime`.

Popup сохраняет existing bootstrap/legacy controls, но orchestra state/actions теперь проходят generic API transport. `chrome.runtime.reload()` после Project Bundle import остаётся extension-host behavior и не является частью Dashboard Core.

### Standalone Fake host

`dashboard/standalone.html` + `dashboard/fake-transport.js` запускают тот же `DashboardApp` без Chrome APIs и внутренних stores. Это Phase 12 parity harness и foundation будущего desktop renderer.

## Debug bundle

`exportDebugBundle` экспортирует observability-only JSON. Он предназначен для troubleshooting и не содержит browser session identifiers или raw transcripts. Project migration data по-прежнему экспортируется отдельным Phase 11 Project Bundle.

## Migration boundary

Phase 12 НЕ добавляет:

- Electron/Tauri shell;
- desktop IPC process;
- local Git/worktrees;
- Playwright/CDP AgentRuntime;
- context compaction.

Следующая фаза — Context Management + Portable Agent Packets.
