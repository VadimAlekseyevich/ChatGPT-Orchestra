# Phase 10 — Platform Boundary + Orchestrator API

Phase 10 превращает существующий alpha.10 runtime в переносимый control path, не меняя orchestration semantics и не начиная desktop rewrite.

## Цель

Planning, Scheduler, Review, Integration, Recovery и Protocol не должны зависеть от конкретного способа управления браузером, persistence backend или watchdog timer.

Extension остаётся рабочей production/reference оболочкой, но platform-specific APIs находятся в composition/adapters:

```text
Extension UI / content scripts
          │
          ▼
background/service-worker.js     ← extension composition root
          │
          ├─ ChromeStorageStateStore
          ├─ ExtensionAgentRuntime
          ├─ ChromeAlarmRuntime
          │
          ▼
      Orchestrator API
          │
          ▼
Planning / Scheduler / Review / Integration / Recovery
```

## AgentRuntime v1

`AgentRuntime` отделяет logical agent от browser tab/page.

Core оперирует:

```text
agentId
sessionId
runtime binding
protocol context
agent status
```

Extension implementation хранит compatibility mapping `agentId ↔ tabId` через существующий `TabRegistry`, но `ServiceWorkerOrchestrator` больше не вызывает `chrome.tabs` напрямую.

Основные runtime operations:

```text
get/list agent
isAgentConnected
create/get/navigate/remove session
bind logical agent to session
send prompt
stop generation
ping/heartbeat
set/clear protocol context
normalize inbound sender identity
```

Будущий Playwright/CDP runtime должен реализовать тот же contract без изменения Scheduler/Review/Integration.

## StateStore v1

Минимальный contract:

```js
await store.get(key)
await store.set({ [key]: value })
```

`ChromeStorageStateStore` — extension adapter для `chrome.storage.local`.

`MemoryStateStore` используется deterministic tests и доказывает, что EventStore/portable boundaries могут работать без Chrome globals.

Phase 10 сознательно сохраняет старые storage keys и state schemas. Canonical portable schema, migrations, SQLite и project export/import относятся к Phase 11.

## TimerRuntime v1

Watchdog больше не создаёт `chrome.alarms` внутри orchestration flow.

Extension composition использует:

```text
ChromeAlarmRuntime
```

Tests используют:

```text
DeterministicTimerRuntime
```

Timer срабатывает только при явном `fire()`, что делает watchdog/recovery tests воспроизводимыми.

## Orchestrator API v1

UI больше не должен знать internal stores.

Commands:

```text
startProject
startExecution
registerActiveLead
createWorkers
bindProtocolContext
clearProtocolContext
sendAgentPrompt
stopAgent
schedulerTick
pause
stopNow
resume
```

Queries:

```text
state
events
project
scheduler
schedulerDecisions
recovery
```

`state` агрегирует project/scheduler/review/integration/recovery DTO и agent pool.

Текущий popup продолжает посылать старые runtime message names. В Phase 10 они являются только transport mapping на `OrchestratorApi.handleLegacyMessage()`. Будущий desktop renderer сможет вызывать `query/execute` через IPC без изменения API semantics.

## Event sender identity

EventBus больше не требует Chrome `sender.tab.id` как canonical sender identity.

Нормализованный source:

```json
{
  "kind": "agent-session",
  "sessionId": "42",
  "agentId": "agent-2"
}
```

Extension adapter может дополнительно сохранить `legacyTabId` для диагностики и backward-compatible logs. Protocol authorization по-прежнему привязан к logical `agentId + protocolContext`.

## Browser boundary

Portable orchestration boundary не должна содержать прямых:

```text
chrome.*
globalThis.chrome
```

Допустимые места browser APIs в alpha.11:

```text
platform/extension-runtime.js
background/service-worker.js
content/**
popup/**
```

`TabRegistry` остаётся extension-compatible agent registry в этой фазе. Удаление platform IDs из переносимого durable snapshot — Phase 11.

## Что Phase 10 НЕ делает

- не добавляет Electron;
- не добавляет SQLite;
- не добавляет Playwright/CDP;
- не переносит файлы ради косметической структуры;
- не меняет Git/review/integration policy;
- не меняет target branch policy;
- не удаляет extension.

## Definition of Done

1. Edge extension по поведению эквивалентна alpha.10.
2. ServiceWorkerOrchestrator не вызывает Chrome APIs напрямую.
3. EventBus принимает platform-neutral sender identity.
4. Watchdog идёт через TimerRuntime.
5. Popup/admin transport маршрутизируется через Orchestrator API.
6. FakeAgentRuntime + MemoryStateStore работают без Chrome globals.
7. Source-level boundary test запрещает прямые browser API зависимости в portable orchestration modules.
8. Existing planning/scheduler/review/integration/recovery regressions остаются green.

Следующая фаза после выполнения этих gates — Phase 11, Portable Persistence + Project Export/Import.
