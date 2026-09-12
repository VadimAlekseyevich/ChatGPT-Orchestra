<div align="center">

# ChatGPT Orchestra

Browser-based multi-agent orchestration for ChatGPT coding workflows.

[![Platform](https://img.shields.io/badge/platform-Microsoft%20Edge-0A7EA4?style=for-the-badge)](#требования-и-permissions)
[![Version](https://img.shields.io/badge/version-2.0.0--alpha.7-orange?style=for-the-badge)](CHANGELOG.md)
[![License](https://img.shields.io/github/license/VadimAlekseyevich/ChatGPT-Orchestra?style=for-the-badge&label=license)](LICENSE)

[Roadmap](ROADMAP.md) · [Changelog](CHANGELOG.md) · [Документация](docs/README.md) · [Issues](../../issues)

</div>

---

## Что это

**ChatGPT Orchestra** — Manifest V3 extension, которая превращает несколько ChatGPT-чатов в управляемый набор coding agents с централизованным project state, versioned protocol, planning pipeline, conflict-aware scheduler и проверяемыми Git-артефактами.

Главный принцип: **чаты — заменяемые исполнители, а не источник истины**. Project state, task graph, runs, protocol events, scheduler decisions и Git provenance принадлежат Orchestrator Core.

Текущая prerelease-версия — **`2.0.0-alpha.7`**.

## Что уже реализовано

| Область | Статус |
|---|---|
| ChatGPT adapter + deterministic completion | Phase 1 |
| Service Worker Orchestrator + Tab Registry | Phase 2 |
| Orchestra Protocol v1 + persisted Event Bus | Phase 3 |
| Project Bootstrap + Planner/Critic/DAG gate | Phase 4 |
| Parallel conflict-aware Scheduler | Phase 5 |
| Per-run Git task isolation + artifact validation | **Phase 6** |
| Independent Review loop | Следующий этап — Phase 7 |
| Integrator / semantic conflicts | Phase 8 |
| Full Pause/Resume/reconciliation | Phase 9 |

Legacy `DONE/FAIL/ERROR` остаётся compatibility mode.

---

## Execution flow

```text
GOAL + GITHUB REPOSITORY
        |
        v
DISCOVERY -> PLAN -> CRITIQUE -> REPLAN -> DECOMPOSE
                                      |
                                      v
                               VALIDATED TASK DAG
                                      |
                                      v
                           CONFLICT-AWARE SCHEDULER
                          /          |          \
                         v           v           v
                     Worker A    Worker B    Worker C
                         |           |           |
                         v           v           v
                     task branch  task branch  task branch
                         \           |           /
                          \          v          /
                         independent Git validation
                                      |
                                      v
                              DONE_UNVERIFIED
                                      |
                                      v
                           Phase 7 Review (next)
```

`DONE_UNVERIFIED` означает: Worker закончил run, а его remote Git artifact прошёл deterministic validation. Это **не** `APPROVED`, `MERGED` или `VERIFIED`.

---

## Planning

После регистрации Lead popup принимает GitHub repository URL и project goal.

Pipeline:

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

Каждая planning stage имеет отдельный `runId` и exact protocol context. Большие planning artifacts передаются отдельно от маленького `@@ORCH` envelope через `@@ORCH_ARTIFACT_BEGIN/END`.

Подробности: [`docs/phase-4-project-planning.md`](docs/phase-4-project-planning.md).

---

## Scheduler

После `READY` пользователь выбирает `Worker slots / maxWorkers` и нажимает **Start Execution**.

Runnable task должна удовлетворять условиям:

```text
status == READY
AND dependencies completed by current policy
AND scheduler == RUNNING
AND Worker slot available
AND no mutually-exclusive active task conflict
```

Scheduler учитывает downstream unlock, priority, risk, file-scope overlap и shared resource locks. Retryable `BLOCKED`, `ERROR`, tab loss и timeout создают новые runs, пока retry budget не исчерпан.

Подробности: [`docs/phase-5-scheduler.md`](docs/phase-5-scheduler.md).

---

## Git Task Isolation — alpha.7

При старте execution Orchestra через read-only GitHub REST provider определяет default branch и фиксирует его точный head SHA как immutable execution base.

Каждая mutating task/run получает уникальную ветку:

```text
orchestra/<projectId>/<taskId>/<runId>
```

Retry создаёт новый `runId`, поэтому не переиспользует branch предыдущей попытки.

Worker обязан:

- начать task branch от выданного `baseSha`;
- никогда не писать напрямую в target branch;
- менять только файлы внутри task scope;
- push'нуть task branch;
- вернуть полный 40-character commit SHA и exact changed-files list.

Финальный event для mutating task выглядит примерно так:

```text
@@ORCH {"v":1,"event":"DONE","projectId":"P1","taskId":"T17","runId":"run-R4","agentId":"A2","eventId":"run-R4-final","sequence":1,"payload":{"summary":"...","testsPerformed":["npm test"],"knownLimitations":[],"git":{"branch":"orchestra/P1/T17/run-R4","commit":"0123456789abcdef0123456789abcdef01234567","baseSha":"...","targetBranch":"main","changedFiles":["src/example.js"]}}}
```

### Что проверяет Orchestra независимо от Worker

`GitHubRestProvider` сверяет:

1. target branch всё ещё находится на captured `baseSha`;
2. exact task branch существует;
3. remote branch head совпадает с reported commit;
4. merge base task commit совпадает с execution base;
5. task branch ahead и не behind относительно base;
6. реальные compare files входят в `scope.allow`;
7. реальные файлы не входят в `scope.deny`;
8. Worker `changedFiles` точно совпадает с GitHub compare.

Только после этого task переходит в `DONE_UNVERIFIED` и может разблокировать downstream work по текущей pre-review policy.

Если target branch сдвинулся, Orchestra fail-closed переходит в `NEEDS_USER`; автоматический rebase не выполняется.

Подробности: [`docs/phase-6-git-task-isolation.md`](docs/phase-6-git-task-isolation.md).

---

## Public/private repository limitation

Первая реализация GitProvider использует read-only `https://api.github.com/*` без хранения GitHub credentials в extension.

Поэтому alpha.7 независимо валидирует репозитории, которые доступны этому provider. Private/unavailable/rate-limited repository **не** получает fallback «поверить Worker'у»: execution/validation останавливается fail-closed.

Будущий authenticated provider/connector сможет использовать тот же scheduler/task contract без изменения run identity.

---

## Orchestra Protocol v1

Каждое event имеет как минимум:

```text
projectId
taskId
runId
agentId
eventId
sequence
```

Event Bus обеспечивает duplicate suppression, event-id collision detection, monotonic sequence, sender identity validation, stale context rejection и persisted audit.

Контракт: [`docs/phase-3-protocol-v1.md`](docs/phase-3-protocol-v1.md).

---

## Быстрый старт

```powershell
git clone https://github.com/VadimAlekseyevich/ChatGPT-Orchestra.git
cd ChatGPT-Orchestra
npm test
npm run test:phase6
```

Затем:

1. открой `edge://extensions/`;
2. включи Developer mode;
3. Load unpacked → папка репозитория;
4. после обновления нажми Reload и обнови ChatGPT tabs;
5. в нужном ChatGPT chat нажми **Эту вкладку → Lead**;
6. укажи repository + project goal;
7. нажми **Start Planning** и дождись `READY`;
8. выставь `Worker slots / maxWorkers`;
9. нажми **Start Execution**;
10. наблюдай scheduler/Git base и task runs.

Для первого Phase 6 smoke-test рекомендуется disposable public repository. Полная инструкция: [`docs/phase-6-smoke-test.md`](docs/phase-6-smoke-test.md).

Runtime extension не требует npm dependencies или build step.

---

## Permissions

Manifest permissions:

- `storage` — settings, registry, events, projects и scheduler state;
- `tabs` — создание/адресация/lifecycle agent tabs;
- `alarms` — MV3 watchdog;
- `https://chatgpt.com/*`, `https://chat.openai.com/*` — ChatGPT adapter;
- `https://api.github.com/*` — read-only independent Git artifact validation.

Orchestra alpha.7 не хранит GitHub token и не выполняет GitHub write API calls из service worker.

---

## Архитектура alpha.7

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
  git-provider.js
  scheduler-store.js
  scheduler-engine.js

protocol/
  orchestra-protocol.js

prompts/
  planning-prompts.js
  worker-prompts.js

content/
  chatgpt-adapter.js
  generation-detector.js
  planning-artifact-parser.js
  protocol-parser.js
  ...
```

`ProjectStore` хранит project/approved graph. `SchedulerStore` хранит mutable runs и Git provenance. `SchedulerEngine` принимает deterministic dispatch/validation decisions. `GitProvider` отделяет scheduler model от конкретного Git backend.

---

## Ограничения alpha.7

- `DONE_UNVERIFIED` ещё не означает независимое принятие работы;
- Review / `CHANGES_REQUIRED` loop начинается в Phase 7;
- merge/rebase/cherry-pick и semantic integration — Phase 8;
- general Pause/Resume/reconciliation — Phase 9;
- initial GitHub REST provider не имеет private-repo credentials;
- abandoned run branches сохраняются для audit/manual cleanup;
- browser E2E against production ChatGPT остаётся ручным smoke test.

---

## Документация

- [`ROADMAP.md`](ROADMAP.md) — target architecture и phased roadmap;
- [`CHANGELOG.md`](CHANGELOG.md) — release history;
- [`docs/phase-2-tab-registry.md`](docs/phase-2-tab-registry.md);
- [`docs/phase-3-protocol-v1.md`](docs/phase-3-protocol-v1.md);
- [`docs/phase-4-project-planning.md`](docs/phase-4-project-planning.md);
- [`docs/phase-5-scheduler.md`](docs/phase-5-scheduler.md);
- [`docs/phase-6-git-task-isolation.md`](docs/phase-6-git-task-isolation.md);
- [`docs/phase-6-smoke-test.md`](docs/phase-6-smoke-test.md);
- [`docs/adr/`](docs/adr/).

---

## Версионирование

Manifest использует `"version": "2.0.0"`, а prerelease находится в `version_name`: **`2.0.0-alpha.7`**.

Решение: [`docs/adr/0001-versioning-policy.md`](docs/adr/0001-versioning-policy.md).

## Лицензия

MIT — см. [LICENSE](LICENSE).
