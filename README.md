<div align="center">

# ChatGPT Orchestra

Browser-based multi-agent orchestration for ChatGPT coding workflows.

[![Platform](https://img.shields.io/badge/platform-Microsoft%20Edge-0A7EA4?style=for-the-badge)](#требования-и-permissions)
[![Version](https://img.shields.io/badge/version-2.0.0--alpha.5-orange?style=for-the-badge)](CHANGELOG.md)
[![License](https://img.shields.io/github/license/VadimAlekseyevich/ChatGPT-Orchestra?style=for-the-badge&label=license)](LICENSE)

[Roadmap](ROADMAP.md) · [Changelog](CHANGELOG.md) · [Документация](docs/README.md) · [Issues](../../issues)

</div>

---

## Идея

**ChatGPT Orchestra** — Manifest V3 extension, которая превращает несколько ChatGPT-чатов в управляемый оркестр coding-agent'ов с централизованным состоянием, формальным протоколом событий, планированием и последующим DAG scheduling.

Ключевой принцип: **чаты — исполнители, а не источник истины**. Project state, planning artifacts, task graph, события, зависимости и назначения принадлежат Orchestrator Core.

Полная целевая архитектура описана в [`ROADMAP.md`](ROADMAP.md).

---

## Текущий статус

Текущая prerelease-версия — **`2.0.0-alpha.5`**.

- Phase 1 — ChatGPT DOM adapter и deterministic completion detection;
- Phase 2 — service worker и persistent agent/tab registry;
- Phase 3 — Orchestra Protocol v1, persisted Event Bus и idempotency;
- Phase 4 — persisted project bootstrap, staged Planner/Critic pipeline и deterministic DAG validation.

Orchestra уже умеет превратить `goal + GitHub repository` в persisted validated task graph. **Она пока не выполняет DAG автоматически:** parallel scheduler и task assignment начинаются в Phase 5.

| Область | Статус |
|---|---|
| Legacy `DONE/FAIL/ERROR` compatibility runner | Реализован |
| ChatGPT adapter + missed-busy fallback | Phase 1 |
| Service Worker Orchestrator | Phase 2 |
| Persistent agent/tab registry | Phase 2 |
| До 4 Worker tabs + targeted routing | Phase 2 |
| Orchestra Protocol v1 | Phase 3 |
| Persisted Event Bus / duplicate & stale protection | Phase 3 |
| Project Store + immutable project bootstrap | **Phase 4 — реализован** |
| Discovery / Planner / Critic / Replan | **Phase 4 — реализовано** |
| Decomposer / DAG Critic | **Phase 4 — реализовано** |
| Deterministic DAG readiness gate | **Phase 4 — реализован** |
| Parallel task scheduler | Следующий этап — Phase 5 |
| Git isolation/review/integration | Phase 6–8 |
| Full Pause/Resume + crash recovery | Phase 9 |

---

## Project Bootstrap

Popup теперь принимает:

- HTTPS GitHub repository URL вида `https://github.com/owner/repo`;
- цель проекта/изменения.

Перед стартом нужно явно зарегистрировать текущую ChatGPT-вкладку как **Lead**.

Project Store сохраняет в `chrome.storage.local`:

```text
projectId
immutable initial goal
normalized repository identity
status / planning stage / current run
planning artifacts
stage history
final task graph
DAG validation result
```

Для alpha допускается один активный project за раз. Project state не зависит от жизненного цикла конкретной вкладки.

---

## Planning pipeline

Phase 4 не сводит планирование к одному prompt:

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

Каждая стадия имеет отдельный `runId` и привязывает Lead к точному `projectId/taskId/runId`. Поэтому старый ответ от предыдущей стадии не может продвинуть текущий pipeline.

### Discovery

Собирает stack, entrypoints, build/test/lint/typecheck, модули, persistence/schema, CI, conventions, существующие repository instructions/`AGENTS.md`, sensitive areas, constraints и access gaps.

### Planner / Critic / Replan

`PLAN_V1` создаёт первоначальный план. `CRITIQUE` специально ищет скрытые зависимости, fake parallelism, oversized work, scope overlap, пропущенные tests/acceptance criteria, migration/API/security risks и unverifiable outcomes. `PLAN_V2` обязан исправить существенные замечания либо явно обосновать отказ.

Существующий `AGENTS.md` не перезаписывается автоматически. План может вернуть только `agentsMdProposal`.

### Decomposer / DAG Critic

Декомпозиция строится вокруг **минимальной независимо проверяемой и потенциально mergeable единицы работы**, а не правила «один prompt = одна task».

Каждая code-task должна иметь как минимум:

```text
id
title
objective
dependencies
scope.allow
acceptanceCriteria
verification или verificationWaiver
priority
risk
estimatedComplexity
```

Большая task требует `decompositionRationale`; migration/schema/database risk требует `migrationPlan`.

---

## Large planning artifacts

Protocol v1 намеренно ограничивает финальный `@@ORCH` envelope. План или DAG может быть намного больше, поэтому Phase 4 передаёт большой artifact отдельно:

```text
@@ORCH_ARTIFACT_BEGIN
{
  "...": "complete stage artifact"
}
@@ORCH_ARTIFACT_END
@@ORCH {"v":1,"event":"DONE","projectId":"...","taskId":"planning:discovery","runId":"...","agentId":"...","eventId":"...","sequence":1,"payload":{"stage":"DISCOVERY"}}
```

Последняя строка остаётся маленьким idempotent event. Artifact parser принимает только bounded JSON object. Для planning `BLOCKED`, `ERROR` и `NEEDS_USER` большой artifact не нужен.

Accepted event сохраняет planning artifact в provenance Event Store, а завершённая стадия — в Project Store. Это позволяет восстановиться даже из crash-window между принятием protocol event и записью stage artifact.

Подробности: [`docs/phase-4-project-planning.md`](docs/phase-4-project-planning.md).

---

## Deterministic DAG gate

Project получает статус `READY` только после deterministic validation. Проверяются:

- непустой graph и bounded task count;
- уникальные task IDs;
- существование dependency IDs;
- отсутствие self-dependency и cycles;
- objective/title;
- acceptance criteria;
- `scope.allow`;
- verification или явный waiver для code task;
- complexity metadata;
- rationale для large task;
- migration safety metadata для migration/schema/database risk;
- explicit objective coverage.

Validator также формирует topological order и graph statistics.

`DONE` от Lead сам по себе **не означает `READY`**.

---

## Orchestra Protocol v1

Protocol envelope должен быть последней непустой строкой assistant response:

```text
@@ORCH {"v":1,"event":"DONE","projectId":"P1","taskId":"T17","runId":"R4","agentId":"A2","eventId":"E91","sequence":3,"payload":{}}
```

Обязательная identity:

```text
projectId
taskId
runId
agentId
eventId
sequence
```

Event Bus persisted-state обеспечивает:

- exact duplicate suppression;
- `event_id_collision` для того же eventId с другим содержимым;
- monotonic sequence;
- stale project/task/run rejection;
- sender tab ↔ agent identity validation;
- accepted/rejected event audit.

Контракт: [`docs/phase-3-protocol-v1.md`](docs/phase-3-protocol-v1.md).

---

## Agent Pool

Popup умеет:

- явно зарегистрировать текущий ChatGPT tab как Lead;
- создать до четырёх Worker tabs;
- показывать `CONNECTING / IDLE / BUSY / ERROR / OFFLINE`;
- восстанавливать known tab identity после reload;
- адресовать prompt конкретному `agentId`.

Обычные пользовательские ChatGPT-вкладки не становятся агентами автоматически.

Контракт: [`docs/phase-2-tab-registry.md`](docs/phase-2-tab-registry.md).

---

## Legacy DONE reliability

Legacy `DONE/FAIL/ERROR` остаётся compatibility mode. Completion detector использует не только `stop-button`, но и изменение fingerprint нового assistant response с quiet/stability window, чтобы снизить вероятность пропущенного `DONE`.

Protocol parser имеет приоритет: malformed или valid `@@ORCH` не превращается в legacy marker.

---

## Архитектура alpha.5

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

protocol/
  orchestra-protocol.js

prompts/
  planning-prompts.js

content/
  planning-artifact-parser.js
  chatgpt-adapter.js
  generation-detector.js
  assistant-message-reader.js
  composer-adapter.js
  protocol-parser.js
  ...
```

`ProjectStore` — project source of truth. `PlanningEngine` — deterministic stage state machine. `EventBus` — event identity/idempotency. `ChatGPTAdapter` — UI boundary. `DAG validator` — readiness gate.

---

## Roadmap

- **Phase 0** — Repository reset / Rename hygiene — завершена;
- **Phase 1** — Adapter extraction and deterministic core — `2.0.0-alpha.2`;
- **Phase 2** — Service Worker Orchestrator + Tab Registry — `2.0.0-alpha.3`;
- **Phase 3** — Orchestra Protocol v1 + Event Bus — `2.0.0-alpha.4`;
- **Phase 4** — Project Bootstrap + Lead/Planner/Critic — `2.0.0-alpha.5`;
- **Phase 5** — Scheduler + Parallel Workers — следующий этап;
- **Phase 6+** — Git isolation, review, integration, recovery, dashboard и hardening.

---

## Быстрый старт

```powershell
git clone https://github.com/VadimAlekseyevich/ChatGPT-Orchestra.git
cd ChatGPT-Orchestra
npm test
```

Затем:

1. открой `edge://extensions/`;
2. включи Developer mode;
3. Load unpacked → папка репозитория;
4. после обновления кода нажми Reload у extension и обнови ChatGPT tabs;
5. открой нужный ChatGPT chat → popup → **Эту вкладку → Lead**;
6. укажи repository + project goal;
7. нажми **Start Planning**;
8. наблюдай стадии до `READY`.

Workers можно создать заранее, но Phase 4 ещё не назначает им task graph автоматически.

Development tests:

```powershell
npm test
npm run test:phase4
```

Runtime extension не требует npm dependencies или build step.

---

## Требования и permissions

- Microsoft Edge с Manifest V3;
- Developer mode;
- доступ к `https://chatgpt.com/` или `https://chat.openai.com/`;
- Node.js 18+ только для development tests.

Manifest permissions:

- `storage` — settings, TabRegistry, EventStore и ProjectStore;
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

Service worker Inspect из `edge://extensions/` используется для runtime/event/project debugging. Rejected protocol events сохраняются в EventStore rejection audit.

---

## Документация

- [`ROADMAP.md`](ROADMAP.md) — target architecture и phased implementation plan;
- [`CHANGELOG.md`](CHANGELOG.md) — история изменений;
- [`docs/phase-2-tab-registry.md`](docs/phase-2-tab-registry.md) — agent transport contract;
- [`docs/phase-3-protocol-v1.md`](docs/phase-3-protocol-v1.md) — protocol/event-bus contract;
- [`docs/phase-4-project-planning.md`](docs/phase-4-project-planning.md) — project/planning/DAG contract;
- [`docs/adr/`](docs/adr/) — architecture decisions.

---

## Ограничения alpha.5

- `READY` task graph ещё не исполняется scheduler'ом;
- Worker tabs ещё не получают DAG tasks автоматически;
- Git branch isolation, review и integration ещё не реализованы;
- full Pause/Resume/reconciliation относится к Phase 9;
- persisted planning artifacts пока дублируются между Event Store provenance и Project Store, поэтому storage compaction потребуется позднее;
- extension зависит от production DOM ChatGPT;
- browser E2E against real ChatGPT пока остаётся ручным smoke test.

---

## Версионирование

Manifest использует `"version": "2.0.0"`, а человекочитаемый prerelease находится в `version_name`: **`2.0.0-alpha.5`**.

Решение: [`docs/adr/0001-versioning-policy.md`](docs/adr/0001-versioning-policy.md).

---

## Лицензия

Проект распространяется по лицензии [MIT](LICENSE).
