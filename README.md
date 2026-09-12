<div align="center">

# ChatGPT Orchestra

Browser-based multi-agent orchestration for ChatGPT coding workflows.

[![Platform](https://img.shields.io/badge/platform-Microsoft%20Edge-0A7EA4?style=for-the-badge)](#требования-и-permissions)
[![Version](https://img.shields.io/badge/version-2.0.0--alpha.6-orange?style=for-the-badge)](CHANGELOG.md)
[![License](https://img.shields.io/github/license/VadimAlekseyevich/ChatGPT-Orchestra?style=for-the-badge&label=license)](LICENSE)

[Roadmap](ROADMAP.md) · [Changelog](CHANGELOG.md) · [Документация](docs/README.md) · [Issues](../../issues)

</div>

---

## Идея

**ChatGPT Orchestra** — Manifest V3 extension, которая превращает несколько ChatGPT-чатов в управляемый оркестр coding-agent'ов с централизованным состоянием, формальным протоколом событий, staged planning и conflict-aware DAG scheduling.

Ключевой принцип: **чаты — исполнители, а не источник истины**. Project state, planning artifacts, task graph, mutable task/run state, события, зависимости и назначения принадлежат Orchestrator Core.

Полная целевая архитектура описана в [`ROADMAP.md`](ROADMAP.md).

---

## Текущий статус

Текущая prerelease-версия — **`2.0.0-alpha.6`**.

- Phase 1 — ChatGPT DOM adapter и deterministic completion detection;
- Phase 2 — service worker и persistent agent/tab registry;
- Phase 3 — Orchestra Protocol v1, persisted Event Bus и idempotency;
- Phase 4 — persisted project bootstrap, Planner/Critic pipeline и deterministic DAG validation;
- Phase 5 — persisted scheduler, parallel Worker assignment, conflict prevention, retries и watchdog.

Orchestra уже умеет превратить `goal + GitHub repository` в validated task graph и автоматически раздать независимые runnable tasks нескольким Worker tabs. **Результат выполнения пока не считается принятым кодом:** до Phase 6–8 нет Git isolation, независимого review и integration. Поэтому Worker `DONE` фиксируется как `DONE_UNVERIFIED`.

| Область | Статус |
|---|---|
| Legacy `DONE/FAIL/ERROR` compatibility runner | Реализован |
| ChatGPT adapter + missed-busy fallback | Phase 1 |
| Service Worker Orchestrator | Phase 2 |
| Persistent agent/tab registry | Phase 2 |
| До 4 Worker tabs + targeted routing | Phase 2 |
| Orchestra Protocol v1 | Phase 3 |
| Persisted Event Bus / duplicate & stale protection | Phase 3 |
| Project Store + immutable bootstrap | Phase 4 |
| Discovery / Planner / Critic / Replan | Phase 4 |
| Decomposer / DAG Critic / deterministic gate | Phase 4 |
| Persisted task/run scheduler | **Phase 5 — реализован** |
| Parallel Worker assignment / dependency unlocking | **Phase 5 — реализовано** |
| Conflict-aware locks / retries / watchdog | **Phase 5 — реализовано** |
| Git task isolation | Следующий этап — Phase 6 |
| Independent review / integration | Phase 7–8 |
| Full Pause/Resume + crash recovery | Phase 9 |

---

## Project Bootstrap и Planning

Popup принимает HTTPS GitHub repository URL вида `https://github.com/owner/repo` и цель проекта. Перед стартом пользователь явно регистрирует нужный ChatGPT tab как **Lead**.

Planning pipeline:

```text
DISCOVERY
   ↓
PLAN_V1
   ↓
CRITIQUE
   ↓
PLAN_V2
   ↓
DECOMPOSE
   ↓
DAG_CRITIC
   ↓
deterministic DAG validation
   ↓
READY
```

Каждая стадия имеет отдельный `runId` и exact protocol context. Старый ответ предыдущей стадии не может продвинуть новый run.

Большие planning artifacts передаются отдельно от маленького Protocol v1 envelope:

```text
@@ORCH_ARTIFACT_BEGIN
{
  "...": "complete stage artifact"
}
@@ORCH_ARTIFACT_END
@@ORCH {"v":1,"event":"DONE","projectId":"...","taskId":"planning:...","runId":"...","agentId":"...","eventId":"...","sequence":1,"payload":{"stage":"..."}}
```

Project получает `READY` только после deterministic DAG validation: dependencies, cycles, scope, acceptance criteria, verification, complexity, migration safety и objective coverage.

Подробности: [`docs/phase-4-project-planning.md`](docs/phase-4-project-planning.md).

---

## Scheduler + Parallel Workers

После `READY` пользователь выбирает `Worker slots / maxWorkers` и нажимает **Start Execution**.

Scheduler хранит mutable execution state отдельно от approved DAG:

```text
READY
  ↓
ASSIGNED
  ↓
RUNNING
  ↓
DONE_UNVERIFIED
```

Одна task может иметь несколько runs. Retry всегда создаёт новый `runId`; старый failed run остаётся в истории.

### Runnable policy

В alpha.6 task runnable, если:

```text
status == READY
AND every dependency == DONE_UNVERIFIED
AND scheduler == RUNNING
AND Worker slot is available
AND no mutually-exclusive active task conflicts with it
```

`DONE_UNVERIFIED` — **временная Phase 5 dependency-success policy**. Она нужна, чтобы проверить scheduler до появления независимого review. Это не `APPROVED`, не `MERGED` и не `VERIFIED`.

### Candidate ordering

Scheduler предпочитает:

1. task, разблокирующую больше downstream work;
2. более высокий priority;
3. меньший risk;
4. стабильный task ID для deterministic tie-break.

### Conflict prevention

Пара задач не запускается одновременно, если policy видит:

- overlap в `scope.allow`;
- общий explicit `resourceLock`;
- общий inferred schema/migration resource;
- общий config/manifest resource;
- high-risk shared public contract.

Conflict deferral сохраняется в scheduler decision log. Это реализация принципа **conflict prevention > conflict resolution**.

### Retry / watchdog

Default retry budget — две повторные попытки после первого run. Retryable `BLOCKED`, `ERROR`, tab loss или timeout возвращают task в `READY`, пока budget не исчерпан.

После exhaustion или explicit `NEEDS_USER` scheduler/project переходят в `NEEDS_USER` и новые assignments прекращаются.

MV3 `alarms` будит watchdog раз в минуту. Default stale timeout — 20 минут. Timeout учитывает не только protocol events, но и `TabRegistry.lastSeenAt`, поэтому длинная живая ChatGPT generation с обычными heartbeat не считается зависшей.

Когда все tasks завершены по временной Phase 5 policy, статус становится:

```text
COMPLETED_UNVERIFIED
```

Подробный контракт: [`docs/phase-5-scheduler.md`](docs/phase-5-scheduler.md).

---

## Worker assignment safety

Перед prompt scheduler:

1. создаёт persisted run;
2. связывает Worker с exact `projectId/taskId/runId`;
3. адресно отправляет assignment конкретному `agentId`.

Worker prompt запрещает расширять scope, выдавать `APPROVED/VERIFIED/MERGED` и делать unsafe direct push/merge в target branch до Phase 6.

Финальный response должен иметь один protocol event, например:

```text
@@ORCH {"v":1,"event":"DONE","projectId":"P1","taskId":"T17","runId":"run-R4","agentId":"A2","eventId":"run-R4-final","sequence":1,"payload":{"summary":"...","testsPerformed":[],"knownLimitations":[],"changedFiles":[]}}
```

`BLOCKED`, `ERROR` и `NEEDS_USER` используют ту же assignment identity.

---

## Orchestra Protocol v1

Protocol envelope должен быть последней непустой строкой assistant response.

Обязательная identity:

```text
projectId
taskId
runId
agentId
eventId
sequence
```

Event Bus обеспечивает exact duplicate suppression, `event_id_collision`, monotonic sequence, stale project/task/run rejection, sender tab ↔ agent validation и persisted accepted/rejected audit.

Контракт: [`docs/phase-3-protocol-v1.md`](docs/phase-3-protocol-v1.md).

---

## Agent Pool

Popup умеет:

- явно зарегистрировать текущий ChatGPT tab как Lead;
- создать до четырёх Worker tabs;
- использовать это же значение как `maxWorkers` при execution;
- показывать `CONNECTING / IDLE / BUSY / ERROR / OFFLINE`;
- восстанавливать known tab identity после reload;
- адресовать prompt конкретному `agentId`.

Обычные пользовательские ChatGPT tabs не становятся агентами автоматически.

Контракт: [`docs/phase-2-tab-registry.md`](docs/phase-2-tab-registry.md).

---

## Legacy DONE reliability

Legacy `DONE/FAIL/ERROR` остаётся compatibility mode. Completion detector использует явный generation signal плюс изменение fingerprint нового assistant response и quiet/stability window. Это закрывает известный failure mode, когда старый detector иногда пропускал `DONE`, если не успевал увидеть `stop-button`.

Protocol parser имеет приоритет: `@@ORCH` никогда не превращается в legacy marker.

---

## Архитектура alpha.6

```text
background/
  service-worker.js
  orchestrator.js
  tab-registry.js
  event-store.js
  event-bus.js
  project-store.js
  planning-engine.js
  dag-validator.js
  conflict-policy.js
  scheduler-store.js
  scheduler-engine.js

protocol/
  orchestra-protocol.js

prompts/
  planning-prompts.js
  worker-prompts.js

content/
  planning-artifact-parser.js
  chatgpt-adapter.js
  generation-detector.js
  assistant-message-reader.js
  composer-adapter.js
  protocol-parser.js
  ...
```

`ProjectStore` хранит project/approved graph. `SchedulerStore` хранит mutable task/run execution state. `SchedulerEngine` принимает deterministic dispatch decisions. `EventBus` отвечает за event identity/idempotency. `ChatGPTAdapter` остаётся UI boundary.

---

## Roadmap

- **Phase 0** — Repository reset / Rename hygiene — завершена;
- **Phase 1** — Adapter extraction and deterministic core — `2.0.0-alpha.2`;
- **Phase 2** — Service Worker Orchestrator + Tab Registry — `2.0.0-alpha.3`;
- **Phase 3** — Orchestra Protocol v1 + Event Bus — `2.0.0-alpha.4`;
- **Phase 4** — Project Bootstrap + Lead/Planner/Critic — `2.0.0-alpha.5`;
- **Phase 5** — Scheduler + Parallel Workers — `2.0.0-alpha.6`;
- **Phase 6** — Git Task Isolation — следующий этап;
- **Phase 7+** — review, integration, recovery, dashboard и hardening.

---

## Быстрый старт

```powershell
git clone https://github.com/VadimAlekseyevich/ChatGPT-Orchestra.git
cd ChatGPT-Orchestra
npm test
npm run test:phase5
```

Затем:

1. открой `edge://extensions/`;
2. включи Developer mode;
3. Load unpacked → папка репозитория;
4. после обновления кода нажми Reload и обнови ChatGPT tabs;
5. в нужном ChatGPT chat нажми **Эту вкладку → Lead**;
6. укажи repository + project goal;
7. нажми **Start Planning** и дождись `READY`;
8. выставь `Worker slots / maxWorkers`;
9. нажми **Start Execution**;
10. наблюдай за parallel assignments и task counters до `COMPLETED_UNVERIFIED`.

Runtime extension не требует npm dependencies или build step.

---

## Требования и permissions

- Microsoft Edge с Manifest V3;
- Developer mode;
- доступ к `https://chatgpt.com/` или `https://chat.openai.com/`;
- Node.js 18+ только для development tests.

Manifest permissions:

- `storage` — settings, TabRegistry, EventStore, ProjectStore и SchedulerStore;
- `tabs` — создание, адресация и lifecycle agent tabs;
- `alarms` — minute-level MV3 scheduler watchdog;
- host permissions — только ChatGPT domains.

---

## Диагностика

Content DevTools (`F12`) полезны для:

```text
response_changed
assistant_response_completed
orchestra_protocol_event_submitted
legacy_flag_not_matched
```

Service worker Inspect используется для runtime/event/project/scheduler debugging. Event Store хранит protocol audit; Scheduler Store — bounded decision log с assignments, conflict deferrals, retries, timeouts и escalation.

---

## Документация

- [`ROADMAP.md`](ROADMAP.md) — target architecture и phased implementation plan;
- [`CHANGELOG.md`](CHANGELOG.md) — история изменений;
- [`docs/phase-2-tab-registry.md`](docs/phase-2-tab-registry.md) — agent transport contract;
- [`docs/phase-3-protocol-v1.md`](docs/phase-3-protocol-v1.md) — protocol/event-bus contract;
- [`docs/phase-4-project-planning.md`](docs/phase-4-project-planning.md) — project/planning/DAG contract;
- [`docs/phase-5-scheduler.md`](docs/phase-5-scheduler.md) — scheduler/task/run/conflict contract;
- [`docs/phase-5-smoke-test.md`](docs/phase-5-smoke-test.md) — Phase 5 acceptance checks;
- [`docs/adr/`](docs/adr/) — architecture decisions.

---

## Ограничения alpha.6

- `DONE_UNVERIFIED` временно разблокирует dependencies, но ещё не означает принятую работу;
- Git branch isolation и commit/scope validation начнутся в Phase 6;
- independent review / `CHANGES_REQUIRED` loop — Phase 7;
- integration/semantic conflict handling — Phase 8;
- general Pause/Resume/user-resolution/reconciliation — Phase 9;
- scheduler conflict heuristic консервативен и может уменьшать полезный parallelism;
- extension зависит от production DOM ChatGPT;
- browser E2E against real ChatGPT пока остаётся ручным smoke test.

---

## Версионирование

Manifest использует `"version": "2.0.0"`, а человекочитаемый prerelease находится в `version_name`: **`2.0.0-alpha.6`**.

Решение: [`docs/adr/0001-versioning-policy.md`](docs/adr/0001-versioning-policy.md).

---

## Лицензия

Проект распространяется по лицензии [MIT](LICENSE).
