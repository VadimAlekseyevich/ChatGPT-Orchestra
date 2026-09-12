<div align="center">

# ChatGPT Orchestra

Browser-based multi-agent orchestration for ChatGPT coding workflows.

[![Platform](https://img.shields.io/badge/platform-Microsoft%20Edge-0A7EA4?style=for-the-badge)](#требования-и-permissions)
[![Version](https://img.shields.io/badge/version-2.0.0--alpha.4-orange?style=for-the-badge)](CHANGELOG.md)
[![License](https://img.shields.io/github/license/VadimAlekseyevich/ChatGPT-Orchestra?style=for-the-badge&label=license)](LICENSE)

[Roadmap](ROADMAP.md) · [Changelog](CHANGELOG.md) · [Документация](docs/README.md) · [Issues](../../issues)

</div>

---

## Идея

**ChatGPT Orchestra** — Manifest V3 extension, цель которого — превратить несколько ChatGPT-чатов в управляемый оркестр coding-agent'ов с централизованным состоянием, адресацией, protocol events и последующим DAG scheduling.

Ключевая идея: **чаты — исполнители, а не источник истины**. Состояние проекта, задачи, события, зависимости и назначения должны принадлежать Orchestrator Core.

Полная целевая архитектура описана в [`ROADMAP.md`](ROADMAP.md).

---

## Текущий статус

Текущая prerelease-версия — **`2.0.0-alpha.4`**.

- Phase 1: DOM adapter + deterministic completion detection;
- Phase 2: service worker + persistent agent/tab registry;
- Phase 3: Orchestra Protocol v1 + persisted Event Bus + idempotency.

Это уже multi-tab event-driven orchestration foundation, но **ещё не автономный task orchestrator**: project bootstrap, Planner/Critic, DAG scheduler, Git isolation, review/integration и full recovery идут дальше по roadmap.

| Область | Статус |
|---|---|
| Legacy `DONE/FAIL/ERROR` runner | Реализован как compatibility mode |
| ChatGPT adapter layer | Phase 1 |
| Missed-busy completion fallback | Phase 1 |
| Service Worker Orchestrator | Phase 2 |
| Persistent agent/tab registry | Phase 2 |
| До 4 Worker tabs + targeted routing | Phase 2 |
| Orchestra Protocol v1 | **Phase 3 — реализован** |
| Persisted Event Bus / `processedEvents` | **Phase 3 — реализован** |
| Duplicate / stale-event protection | **Phase 3 — реализована** |
| Protocol context binding | **Phase 3 — реализован** |
| Planner/Critic/DAG | Следующий этап — Phase 4 |
| Parallel task scheduler | Phase 5 |
| Git isolation/review/integration | Phase 6–8 |
| Pause/Resume + crash recovery проекта | Phase 9 |

---

## Orchestra Protocol v1

Новый protocol envelope должен быть **последней непустой строкой assistant response**.

Основной формат:

```text
@@ORCH {"v":1,"event":"DONE","projectId":"P1","taskId":"T17","runId":"R4","agentId":"A2","eventId":"E91","sequence":3,"payload":{"commit":"abc123"}}
```

Поддерживается compact fallback:

```text
@@ORCH|v=1|event=DONE|projectId=P1|taskId=T17|runId=R4|agentId=A2|eventId=E91|sequence=3
```

Обязательная identity каждого события:

```text
projectId
taskId
runId
agentId
eventId
sequence
```

Поддерживаемые event types v1:

```text
READY
TASK_ACCEPTED
PROGRESS
DONE
BLOCKED
ERROR
REVIEW_APPROVED
CHANGES_REQUIRED
CONFLICT
CONFLICT_RESOLVED
NEEDS_USER
HEARTBEAT
```

События маршрутизируются по deterministic route classes: lifecycle, progress, completion, blocker, review, integration и user.

Подробный контракт: [`docs/phase-3-protocol-v1.md`](docs/phase-3-protocol-v1.md).

---

## Idempotency и stale-event safety

Event Bus хранит состояние в `chrome.storage.local`:

- `eventCursor`;
- `processedEvents`;
- порядок обработанных event IDs;
- последнюю sequence для каждого `project/task/run/agent`;
- accepted event audit;
- rejection audit.

Правила:

- точный replay одного события возвращается как `duplicate` и не создаёт второй event;
- тот же `eventId` с другим payload — `event_id_collision`;
- sequence назад или повтор sequence — `stale_sequence`;
- sender tab обязан быть зарегистрирован;
- `agentId` envelope обязан совпасть с agent registry;
- если orchestrator привязал agent к `projectId/taskId/runId`, событие с чужим context отклоняется;
- неизвестная версия, event type или malformed envelope не производят автоматический side effect.

Это transport/event foundation. Phase 4/5 будут привязывать protocol context автоматически при создании project/task/run assignments.

---

## Agent Pool

Popup умеет явно связать текущую ChatGPT-вкладку с ролью **Lead** и создать до четырёх **Worker**-вкладок.

Правила безопасности:

- обычная вкладка ChatGPT не становится агентом автоматически;
- Lead назначается только явным действием пользователя;
- Worker получает `agentId/tabId` до navigation в ChatGPT;
- незарегистрированные вкладки не запускают периодический heartbeat;
- закрытый Worker становится `OFFLINE`, но logical identity сохраняется;
- prompt адресуется конкретному `agentId`.

Health states Phase 2:

```text
CONNECTING
IDLE
BUSY
ERROR
OFFLINE
```

Контракт: [`docs/phase-2-tab-registry.md`](docs/phase-2-tab-registry.md).

---

## Legacy foundation и надёжность DONE

Legacy `DONE/FAIL/ERROR` остаётся compatibility layer.

Phase 1 исправила ключевой failure mode: completion больше не зависит только от `stop-button`. `GenerationDetector` использует явный busy signal плюс изменение fingerprint последнего assistant response, а side effect разрешается только после stability window.

Legacy rules:

| Флаг | Действие | Значение по умолчанию |
|---|---|---|
| `DONE` | Отправить промпт | `Делай следующее задание` |
| `FAIL` | Позвать пользователя | `Требуется ваше участие. Откройте чат ChatGPT.` |
| `ERROR` | Отправить промпт | Попытаться исправить ошибку и продолжить |

Protocol parser имеет приоритет над legacy rules: строка с `@@ORCH` никогда не трактуется как legacy marker.

---

## Архитектура текущей alpha

```text
background/
  service-worker.js
  orchestrator.js
  tab-registry.js
  event-store.js
  event-bus.js

protocol/
  orchestra-protocol.js

content/
  selectors.js
  utils.js
  logger.js
  message-types.js
  generation-state.js
  generation-detector.js
  assistant-message-reader.js
  composer-adapter.js
  protocol-parser.js
  runtime-messenger.js
  chatgpt-adapter.js
  legacy-controller.js

content.js
popup-orchestrator.js
```

`ChatGPTAdapter` изолирует production DOM. `TabRegistry` хранит transport identity. `OrchestraProtocol` валидирует envelope. `EventStore/EventBus` отвечают за persisted idempotency, sequence и routing. `ServiceWorkerOrchestrator` связывает эти уровни.

---

## Roadmap

- **Phase 0** — Repository reset / Rename hygiene — завершена;
- **Phase 1** — Adapter extraction and deterministic core — `2.0.0-alpha.2`;
- **Phase 2** — Service Worker Orchestrator + Tab Registry — `2.0.0-alpha.3`;
- **Phase 3** — Orchestra Protocol v1 + Event Bus — `2.0.0-alpha.4`;
- **Phase 4** — Project Bootstrap + Lead/Planner/Critic — следующий этап;
- **Phase 5+** — scheduler, Git isolation, review, integration, recovery и dashboard.

---

## Быстрый старт

1. Клонируй репозиторий:

```powershell
git clone https://github.com/VadimAlekseyevich/ChatGPT-Orchestra.git
cd ChatGPT-Orchestra
```

2. Открой `edge://extensions/`, включи Developer mode и выбери **Load unpacked**.
3. Выбери папку репозитория с `manifest.json`.
4. После обновления исходников нажми **Reload** у расширения и обнови ChatGPT tabs.
5. В нужном чате открой popup и нажми **Эту вкладку → Lead**.
6. Создай Worker tabs.

Development tests:

```powershell
npm test
npm run test:phase3
```

Runtime extension не требует npm dependencies или build step.

---

## Требования и permissions

- Microsoft Edge с Manifest V3;
- Developer mode;
- доступ к `https://chatgpt.com/` или `https://chat.openai.com/`;
- Node.js 18+ только для development tests.

Manifest permissions:

- `storage` — settings, TabRegistry и EventStore;
- `tabs` — создание, адресация и lifecycle agent tabs;
- host permissions только для ChatGPT domains.

---

## Диагностика

Content DevTools (`F12`) полезны для:

```text
response_changed
assistant_response_completed
orchestra_protocol_event_submitted
legacy_flag_not_matched
```

Service worker Inspect из `edge://extensions/` используется для runtime/event debugging. Rejected protocol events сохраняются в persisted rejection audit EventStore.

---

## Версионирование

Manifest использует числовое:

```json
"version": "2.0.0"
```

Human-readable prerelease:

```json
"version_name": "2.0.0-alpha.4"
```

Подробное решение: [`docs/adr/0001-versioning-policy.md`](docs/adr/0001-versioning-policy.md).

---

## Документация

- [`ROADMAP.md`](ROADMAP.md) — целевая архитектура и phased implementation plan;
- [`CHANGELOG.md`](CHANGELOG.md) — история изменений;
- [`docs/phase-2-tab-registry.md`](docs/phase-2-tab-registry.md) — transport/registry contract;
- [`docs/phase-3-protocol-v1.md`](docs/phase-3-protocol-v1.md) — protocol/event-bus contract;
- [`docs/README.md`](docs/README.md) — индекс документации;
- [`docs/adr/`](docs/adr/) — Architecture Decision Records.

---

## Ограничения текущей версии

- project source of truth ещё не реализован;
- Planner/Critic и DAG ещё не реализованы;
- protocol context пока предоставляет механизм привязки, но scheduler начнёт управлять им только в следующих фазах;
- Worker tabs пока не получают реальные task assignments автоматически;
- Git isolation, review и integration ещё не реализованы;
- full Pause/Resume/crash recovery относится к Phase 9;
- extension всё ещё зависит от production DOM ChatGPT;
- browser E2E against real ChatGPT пока остаётся ручным smoke test.

---

## Лицензия

Проект распространяется по лицензии [MIT](LICENSE).
