# ChatGPT Orchestra — Detailed Roadmap

> Статус документа: архитектурный и продуктовый roadmap.
>
> Цель: превратить текущий single-tab `DONE/FAIL/ERROR` auto-continue MVP в устойчивый multi-agent orchestrator, который принимает задачу и GitHub-репозиторий, строит и критикует план, декомпозирует его в DAG независимых задач, распределяет работу между несколькими ChatGPT-агентами, организует review/integration и умеет безопасно ставить проект на паузу и продолжать после перезапуска.

---

## 1. Видение продукта

### 1.1. Целевой пользовательский сценарий

Пользователь должен иметь возможность сделать минимум действий:

1. открыть ChatGPT;
2. дать цель проекта/изменения;
3. дать ссылку на GitHub-репозиторий;
4. нажать `Start Orchestra`;
5. наблюдать за процессом или уйти;
6. при необходимости нажать `Pause`;
7. позже открыть браузер и нажать `Resume`;
8. получить готовые изменения, историю решений, результаты проверок и понятный итоговый отчёт.

Идеальный UX:

```text
USER GOAL + REPOSITORY
        |
        v
DISCOVERY -> PLAN -> CRITIQUE -> REPLAN -> DECOMPOSE
                                      |
                                      v
                                  TASK DAG
                                      |
                                      v
                     SCHEDULER / ORCHESTRATOR CORE
                     /        |        |        \
                    v         v        v         v
                Worker A  Worker B Worker C  Worker D
                     \        |        |        /
                      \       v        v       /
                       ------ Reviewer -------
                              |
                              v
                          Integrator
                              |
                              v
                           Git/CI
                              |
                              v
                         FINAL REVIEW
                              |
                              v
                            USER
```

### 1.2. Что такое ChatGPT Orchestra

ChatGPT Orchestra — не «несколько вкладок, которые разговаривают друг с другом».

Целевая модель:

- вкладки ChatGPT — **исполнительные узлы**;
- extension service worker — **центральный orchestrator**;
- task graph — **план выполнения**;
- event log — **история фактов**;
- project state — **источник истины**;
- Git branches/commits/PR — **артефакты работы**;
- главный чат — **Lead/Architect/Reviewer**, но не база данных;
- worker-чаты — **заменяемые исполнители**;
- Integrator — **роль**, а не обязательно постоянно занятая вкладка.

### 1.3. Главный принцип

> Чаты не должны быть источником состояния системы.

Любой чат может:

- зависнуть;
- закрыться;
- быть перезагружен;
- потерять часть контекста;
- повторить старый ответ;
- вернуть некорректный служебный флаг;
- быть заменён новым чатом.

После любого такого события Orchestra должна понимать, что уже сделано, что выполняется, кто чем занят и какой следующий безопасный шаг.

---

## 2. Не-цели первой большой версии

Чтобы не превратить проект в бесконечную платформу до появления работающего продукта, в первой архитектурной итерации НЕ требуется:

- собственный LLM backend;
- собственный inference;
- десятки одновременно работающих агентов;
- распределённый серверный scheduler;
- полноценная IDE;
- автоматическая поддержка всех AI-сервисов;
- сложное обучение агентов на истории;
- автономный self-modifying orchestrator;
- гарантия полностью unattended разработки любого проекта.

Первый серьёзный релиз должен доказать более узкую гипотезу:

> 1 Lead + N Workers + Reviewer/Integrator могут устойчиво выполнить заранее ограниченную программную задачу быстрее и надёжнее одного последовательного чата, сохраняя recoverable state и контролируемый Git workflow.

---

## 3. Архитектурные принципы

### 3.1. Orchestrator-first

Все межагентные взаимодействия проходят через Orchestrator Core.

Запрещённая целевая архитектура:

```text
Worker A -> Worker B -> Integrator -> Worker A
```

Правильная:

```text
Worker A -> Orchestrator -> Integrator
Integrator -> Orchestrator -> Worker A
```

### 3.2. Event-driven, а не prompt-chain-driven

Система реагирует не на «смысл текста вообще», а на формализованные события:

- `READY`;
- `TASK_ACCEPTED`;
- `PROGRESS`;
- `DONE`;
- `BLOCKED`;
- `ERROR`;
- `REVIEW_APPROVED`;
- `CHANGES_REQUIRED`;
- `CONFLICT`;
- `CONFLICT_RESOLVED`;
- `NEEDS_USER`;
- `HEARTBEAT`.

### 3.3. Idempotency everywhere

Повтор одного события не должен приводить к повторному merge, повторной выдаче той же задачи или повторному выполнению необратимого действия.

Каждое событие имеет как минимум:

```text
projectId
taskId
runId
eventId
agentId
sequence
```

### 3.4. Recoverability

В любой момент должно быть возможно:

- закрыть браузер;
- открыть его позже;
- восстановить проект;
- определить статус каждой задачи;
- проверить Git-состояние;
- продолжить только безопасные операции.

### 3.5. Conflict prevention > conflict resolution

Лучше не допускать конфликтов декомпозицией и scheduling, чем героически решать их после возникновения.

### 3.6. Проверяемые задачи вместо «один prompt = одна задача»

Единица декомпозиции — не «то, что нейронка выполнит одним запросом», а:

> минимальная независимо проверяемая, ограниченная по scope и потенциально сливаемая единица работы.

Агент внутри такой задачи может сделать несколько шагов.

### 3.7. Human override всегда существует

Пользователь может:

- pause;
- resume;
- stop;
- отменить task;
- перепривязать worker;
- изменить приоритет;
- запретить merge;
- вручную решить блокер;
- потребовать review.

---

## 4. Целевая компонентная архитектура

### 4.1. Browser Extension

```text
extension/
  manifest.json
  background/
    orchestrator.js
    scheduler.js
    event-bus.js
    state-store.js
    tab-registry.js
    recovery.js
    protocol.js
  content/
    chatgpt-adapter.js
    generation-detector.js
    composer-adapter.js
    response-parser.js
  popup/
    popup.html
    popup.js
    popup.css
  dashboard/
    index.html
    app.js
    app.css
```

Текущий `content.js` не выбрасывается. Из него нужно извлечь проверенную DOM-логику в `ChatGPTAdapter`.

### 4.2. Orchestrator Core

Ответственность:

- состояние проекта;
- реестр агентов;
- реестр вкладок;
- маршрутизация событий;
- назначение задач;
- контроль зависимостей;
- retries/timeouts;
- pause/resume;
- crash recovery;
- синхронизация с Git/GitHub-артефактами;
- аудит.

Orchestrator не должен самостоятельно «думать» вместо Lead. Он выполняет детерминированную механику.

### 4.3. ChatGPT Adapter

Content script отвечает только за UI ChatGPT:

- определить начало/конец генерации;
- прочитать последний assistant response;
- извлечь protocol envelope;
- отправить prompt;
- проверить, что composer свободен;
- остановить generation при `Stop Now`;
- сообщать состояние вкладки;
- не принимать глобальных решений.

### 4.4. Agent Pool

Агент — логическая сущность, а не номер вкладки.

Пример:

```json
{
  "agentId": "agent-03",
  "tabId": 417,
  "chatUrl": "https://chatgpt.com/c/...",
  "role": "worker",
  "status": "running",
  "taskId": "T-017",
  "runId": "run-0041",
  "lastSeenAt": 0
}
```

Роли могут меняться:

- Lead;
- Planner;
- Critic;
- Decomposer;
- Worker;
- Reviewer;
- Integrator;
- Debugger;
- Test Reviewer;
- Security Reviewer.

Для MVP несколько функций могут выполняться одним Lead-чатом.

### 4.5. Project State Store

Runtime source of truth хранится в `chrome.storage.local`.

Рекомендуемая модель:

```json
{
  "schemaVersion": 1,
  "projectId": "proj-...",
  "status": "running",
  "repository": {
    "url": "https://github.com/owner/repo",
    "defaultBranch": "main",
    "baseSha": "..."
  },
  "settings": {
    "maxWorkers": 4,
    "autoMerge": false,
    "maxRetries": 2
  },
  "agents": {},
  "tasks": {},
  "runs": {},
  "processedEvents": {},
  "eventCursor": 0,
  "createdAt": 0,
  "updatedAt": 0
}
```

### 4.6. Репозиторные артефакты

Не надо коммитить в Git каждое runtime-событие. Это создаст шум и contention.

В репозитории проекта полезно иметь долговечные артефакты:

```text
AGENTS.md
.orchestra/
  project.md
  plan.md
  task-graph.json
  decisions.md
  final-report.md
```

Опционально:

```text
.orchestra/archive/
```

Runtime event log остаётся локальным/в extension storage, а в репозиторий попадают только значимые checkpoints и решения.

---

## 5. Протокол Orchestra

### 5.1. Почему `DONE` недостаточно

Legacy-флаг полезен, но не отвечает на вопросы:

- какая задача завершена;
- какой run завершён;
- какой commit создан;
- это свежий ответ или старый;
- требуется review или merge;
- завершилась работа или только подшаг.

### 5.2. Формат протокола v1

Предпочтительный формат — одна последняя служебная строка:

```text
@@ORCH {"v":1,"event":"DONE","project":"P1","task":"T17","run":"R4","agent":"A2","eventId":"E91","commit":"abc123"}
```

Почему JSON envelope лучше набора свободных флагов:

- расширяемость;
- строгий parse;
- версия протокола;
- удобное логирование;
- меньше неоднозначности.

Если DOM/рендеринг создаёт проблемы с JSON, должен существовать fallback compact syntax:

```text
@@ORCH|v=1|event=DONE|task=T17|run=R4|eventId=E91|commit=abc123
```

### 5.3. Правила парсинга

Парсер:

1. читает только последнюю непустую строку;
2. требует точный prefix `@@ORCH`;
3. ограничивает максимальный размер envelope;
4. валидирует `v`;
5. валидирует event type;
6. сверяет `task/run/agent` с ожидаемым assignment;
7. отклоняет stale events;
8. проверяет `eventId` на duplicate;
9. не исполняет неизвестные действия автоматически.

### 5.4. Legacy compatibility

На переходном этапе:

```text
DONE  -> legacy DONE
FAIL  -> legacy NEEDS_USER
ERROR -> legacy ERROR
```

После появления protocol v1 старые правила остаются как manual/compatibility mode.

---

## 6. Task model

Минимальная задача:

```json
{
  "id": "T-017",
  "title": "Implement refresh token rotation",
  "objective": "...",
  "status": "ready",
  "priority": 50,
  "dependencies": ["T-012"],
  "scope": {
    "allow": ["src/auth/**", "tests/auth/**"],
    "deny": ["infra/**"]
  },
  "acceptanceCriteria": [
    "new refresh token invalidates old token",
    "existing login flow remains compatible",
    "tests cover reuse of old token"
  ],
  "verification": [
    "npm test -- auth"
  ],
  "expectedArtifacts": [
    "commit"
  ],
  "risk": "medium",
  "estimatedParallelism": "high"
}
```

### 6.1. Task status state machine

```text
DRAFT
  |
  v
READY <---------------------+
  |                         |
  v                         |
ASSIGNED                     |
  |                         |
  v                         |
RUNNING -----> BLOCKED -----+
  |              |
  |              v
  |          NEEDS_USER
  |
  v
DONE_BY_WORKER
  |
  v
REVIEWING
  |        \
  |         \
  v          v
APPROVED   CHANGES_REQUIRED
  |             |
  |             +----> READY/ASSIGNED
  v
INTEGRATING
  |
  +----> INTEGRATION_FAILED -> READY/BLOCKED
  |
  v
MERGED
  |
  v
VERIFIED
```

Terminal states:

- `VERIFIED`;
- `CANCELLED`;
- `FAILED_PERMANENTLY`.

### 6.2. Run model

Одна task может выполняться несколько раз.

```text
T17 / R1 -> failed
T17 / R2 -> changes required
T17 / R3 -> approved
```

Нельзя идентифицировать выполнение только по `taskId`.

---

## 7. DAG и Scheduler

### 7.1. Planner output

Planner должен вернуть не список шагов, а граф:

```json
{
  "tasks": ["T1", "T2", "T3"],
  "edges": [
    ["T1", "T2"],
    ["T1", "T3"]
  ]
}
```

Scheduler определяет `runnable task`:

```text
status == READY
AND all dependencies == VERIFIED/MERGED according to policy
AND no exclusive resource lock
AND project.status == RUNNING
```

### 7.2. Conflict score

Для пары задач оценивается вероятность конфликта.

MVP heuristic:

```text
score = overlap(fileScopes)
      + sharedSubsystemPenalty
      + sameMigrationPenalty
      + sharedSchemaPenalty
```

Планировщик должен снижать параллелизм, если две задачи:

- изменяют один и тот же файл;
- меняют общий публичный API;
- меняют одну БД-схему;
- затрагивают общий config;
- одна фактически зависит от интерфейса другой.

### 7.3. Scheduling policy v1

Приоритет кандидатов:

1. задача разблокирует наибольшее число downstream-задач;
2. высокий business priority;
3. низкий conflict score с уже запущенными задачами;
4. подходящий agent capability;
5. меньший риск — если система восстанавливается после crash.

### 7.4. Worker slots

`maxWorkers` — конфигурация, а не захардкоженное число вкладок.

Начальное значение:

```text
Lead: 1
Worker slots: 4
```

Integrator/Reviewer могут временно занимать один из worker slots либо отдельный слот по настройке.

---

## 8. Planning pipeline

Planning нельзя сводить к одному prompt.

Целевой pipeline:

```text
Repository discovery
       |
       v
Planner -> Plan v1
       |
       v
Critic -> Critique
       |
       v
Planner -> Plan v2
       |
       v
Decomposer -> Task DAG
       |
       v
DAG Critic / Validator
       |
       v
Approved execution graph
```

### 8.1. Repository discovery

Перед планом агент должен собрать:

- язык/stack;
- entrypoints;
- package/build system;
- test commands;
- lint/typecheck;
- основные модули;
- persistence/schema;
- CI;
- coding conventions;
- существующие `AGENTS.md`/contributor instructions;
- возможные sensitive areas;
- размер и структуру репозитория.

### 8.2. Plan Critic checklist

Critic обязан искать:

- скрытые зависимости;
- слишком крупные задачи;
- слишком мелкие бессмысленные задачи;
- overlap scope;
- отсутствующие tests;
- отсутствующие acceptance criteria;
- migrations без rollback/compatibility;
- риск breaking API;
- security impact;
- невозможность проверить результат;
- задачи, которые выглядят параллельными, но семантически зависимы.

### 8.3. DAG validator

Детерминированная часть должна проверить:

- нет циклов;
- все dependency IDs существуют;
- нет orphaned critical tasks;
- каждая task имеет acceptance criteria;
- каждая code task имеет verification strategy либо явную причину её отсутствия;
- scope не пустой;
- terminal objective покрыт набором задач.

---

## 9. Git strategy

### 9.1. Главный принцип

Workers никогда не должны независимо пушить изменения прямо в `main`.

Ветки:

```text
orchestra/<projectId>/<taskId>/<runId>
```

Пример:

```text
orchestra/P12/T17/R3
```

### 9.2. Task output

Успешный worker возвращает:

- branch;
- head commit SHA;
- краткое summary;
- changed files;
- tests performed;
- известные ограничения.

### 9.3. Интеграция

После review:

```text
Worker branch
   |
   v
Review
   |
   v
Integration branch / target branch
   |
   v
Merge/rebase/cherry-pick policy
   |
   v
Integration tests
   |
   v
Accepted
```

### 9.4. Git abstraction

Extension не должна быть архитектурно привязана к одному способу изменения GitHub.

Ввести интерфейс:

```text
GitProvider
  getRepositoryState()
  getBranchState()
  getCommit()
  createBranch()
  compare()
  merge()
  getCIStatus()
```

Первая реализация может опираться на возможности, доступные агенту/подключению GitHub. Позже можно добавить прямую интеграцию с GitHub API или companion service без изменения scheduler/task model.

---

## 10. Review и Integrator

### 10.1. Worker не может сам утвердить свою работу

`DONE` от worker означает только:

> «исполнитель считает работу законченной и предоставил артефакты».

Это НЕ означает `VERIFIED`.

### 10.2. Reviewer проверяет

- acceptance criteria;
- diff соответствует scope;
- нет лишних изменений;
- tests достаточны;
- архитектурные правила соблюдены;
- нет очевидного regression;
- документация обновлена, если требуется.

Результат:

```text
REVIEW_APPROVED
```

или:

```text
CHANGES_REQUIRED
```

с конкретным списком замечаний.

### 10.3. Integrator — не «решатель текстовых Git conflicts»

Integrator отвечает за:

- merge/rebase;
- текстовые конфликты;
- API mismatch;
- semantic conflicts;
- cross-task regressions;
- integration tests;
- согласование изменений между ранее независимыми ветками.

### 10.4. Semantic conflict

Нужно считать конфликтом ситуацию, когда Git merge успешен, но:

- один worker поменял контракт функции;
- другой использует старый контракт;
- тесты падают;
- типы расходятся;
- schema/config assumptions различаются.

Это отдельный класс `INTEGRATION_FAILED`, а не только `MERGE_CONFLICT`.

---

# 11. Версионный roadmap

## Phase 0 — Repository reset / Rename hygiene

**Статус:** завершена в `2.0.0-alpha.1`.

**Цель:** привести репозиторий в состояние, где новое название и новая цель не конфликтуют со старым README.

### Задачи

- [x] переименовать title расширения в `ChatGPT Orchestra`;
- [x] обновить package/manifest description;
- [x] исправить старые repository URLs;
- [x] обновить badges;
- [x] описать legacy MVP как baseline;
- [x] добавить ссылку на этот `ROADMAP.md`;
- [x] решить policy версионирования;
- [x] добавить `CHANGELOG.md`;
- [x] добавить минимальную структуру `docs/` и ADR.

### Definition of Done

- в пользовательской документации нигде не утверждается, что проект всё ещё называется `ChatGPT DONE Auto-Continue`;
- clone/install instructions указывают новый repository;
- старые функции описаны как foundation, а не конечный продукт.

---

## Phase 1 — Adapter extraction and deterministic core

**Статус:** реализуется в `2.0.0-alpha.2`.

**Цель:** отделить DOM automation от логики управления.

### Известная reliability-проблема legacy baseline

Зафиксирован реальный случай, когда ответ завершался флагом `DONE`, но расширение не всегда его обрабатывало. Legacy detector в значительной степени зависел от того, что content script успеет увидеть переход UI через `stop-button`: если busy-состояние было пропущено из-за timing, DOM-изменения или изменения интерфейса ChatGPT, проверка флага могла вообще не запуститься.

Это считается отдельным acceptance requirement Phase 1, а не случайным UI-багом.

Phase 1 должна гарантировать:

- completion detection не зависит от одного selector/signal;
- явный generation/busy signal остаётся основным сигналом, но имеет fallback;
- изменение fingerprint нового assistant response запускает settling даже если busy signal был полностью пропущен;
- side effect разрешён только после quiet/stability window;
- response, уже существующий при загрузке страницы, является baseline и не считается новым completion;
- SPA-navigation в другой существующий conversation создаёт новый baseline и не запускает старый `DONE`;
- одинаковый текст в двух разных assistant turns различается по fingerprint;
- duplicate completion одного и того же response подавляется;
- structured logs позволяют понять, какой signal привёл к completion или почему flag не был обработан.

Обязательный regression scenario:

```text
startup: old response exists -> no action
new assistant response appears
busy/stop-button transition is NOT observed
response becomes stable
DONE is parsed exactly once
```

### Реализация

- [x] разбить `content.js` на модули;
- [x] `GenerationDetector`;
- [x] `ComposerAdapter`;
- [x] `AssistantMessageReader`;
- [x] `ProtocolParser` boundary;
- [x] `ChatGPTAdapter` facade;
- [x] унифицировать сообщения content <-> future background;
- [x] ввести typed message names/constants;
- [x] сохранить legacy `DONE/FAIL/ERROR` behavior;
- [x] добавить structured logs;
- [x] централизовать selectors;
- [x] добавить selector fallback strategy;
- [x] добавить detection для unavailable composer/error page;
- [x] добавить fallback completion detection по response fingerprint;
- [x] добавить SPA navigation baseline reset.

### Тесты

- [x] unit tests parser;
- [x] unit tests generation state transitions;
- [x] fixtures с вариантами response text;
- [x] duplicate response/completion test;
- [x] composer occupied test;
- [x] generation started/stopped test;
- [x] missed-busy recovery test;
- [x] stale page/navigation response test.

### DoD

Старый функционал работает через новый Adapter, а orchestration logic больше не находится внутри DOM observer callback. Browser smoke test реального production ChatGPT остаётся обязательным перед тем, как считать prerelease проверенной в реальном UI.

---

## Phase 2 — Service Worker Orchestrator + Tab Registry

**Цель:** научить extension централизованно управлять несколькими ChatGPT tabs.

### Реализация

- [ ] добавить Manifest V3 service worker;
- [ ] запросить минимально необходимые `tabs`/related permissions;
- [ ] `TabRegistry`;
- [ ] уникальные `agentId`;
- [ ] mapping `agentId <-> tabId <-> chatUrl`;
- [ ] создать N worker tabs;
- [ ] обнаруживать закрытие вкладки;
- [ ] обнаруживать navigation внутри вкладки;
- [ ] reconnect после reload;
- [ ] heartbeat content -> background;
- [ ] отправка prompt конкретному agent;
- [ ] status `IDLE/BUSY/OFFLINE/ERROR`;
- [ ] защита от случайной регистрации обычной пользовательской ChatGPT-вкладки как worker.

### UX

Popup:

```text
Project: none/running
Lead: connected
Workers: 3/4 connected
[Start]
[Pause]
[Stop]
[Open Dashboard]
```

### DoD

Extension создаёт минимум 3 worker tabs, присваивает роли, переживает reload одной вкладки и гарантированно отправляет команду выбранному agent, не затрагивая остальные вкладки.

---

## Phase 3 — Orchestra Protocol v1 + Event Bus

**Цель:** заменить неструктурированные флаги формальным межагентным протоколом.

### Реализация

- [ ] protocol envelope `@@ORCH`;
- [ ] JSON schema/validator;
- [ ] `eventId`;
- [ ] `projectId/taskId/runId/agentId`;
- [ ] monotonic sequence per run;
- [ ] `processedEvents` store;
- [ ] Event Bus;
- [ ] routing table;
- [ ] stale event rejection;
- [ ] duplicate event suppression;
- [ ] malformed protocol -> safe failure;
- [ ] unknown event -> audit + no automatic side effect;
- [ ] legacy fallback mode.

### Failure tests

- одна строка `DONE` приходит дважды;
- вкладка reload после ответа;
- старый ответ прочитан после восстановления;
- worker отправляет `DONE` для чужого taskId;
- worker отправляет invalid JSON;
- duplicate event с другим text body;
- sequence идёт назад.

### DoD

Любое side effect действие можно однозначно связать с уникальным event; повторная обработка не меняет итоговое состояние.

---

## Phase 4 — Project Bootstrap + Lead/Planner/Critic

**Цель:** пользователь задаёт project goal + repository, после чего Orchestra сама подготавливает execution plan.

### Реализация

- [ ] экран `New Project`;
- [ ] repository URL validation;
- [ ] project ID;
- [ ] initial user goal immutable snapshot;
- [ ] Lead initialization prompt;
- [ ] Repository Discovery prompt/template;
- [ ] Planner prompt/template;
- [ ] Critic prompt/template;
- [ ] Replan prompt/template;
- [ ] Decomposer prompt/template;
- [ ] DAG Critic prompt/template;
- [ ] сохранение approved plan;
- [ ] генерация `AGENTS.md` proposal, но не перезапись существующего без review;
- [ ] импорт существующих repository instructions.

### Planning quality gates

План не допускается к execution, если:

- отсутствует хотя бы одна acceptance criterion для code task;
- DAG цикличен;
- dependencies ссылаются на отсутствующие tasks;
- слишком большой task не прошёл critique;
- critical migration не имеет отдельной проверки;
- непонятно, как определить завершение проекта.

### DoD

Для тестового репозитория Orchestra после одного initial request создаёт валидный DAG с dependencies, scope, acceptance criteria и verification commands.

---

## Phase 5 — Scheduler + Parallel Workers

**Цель:** реально выполнять независимые задачи параллельно.

### Реализация

- [ ] task state machine;
- [ ] run state machine;
- [ ] runnable queue;
- [ ] worker availability;
- [ ] maxWorkers setting;
- [ ] priority;
- [ ] dependency unlocking;
- [ ] retries;
- [ ] timeout/watchdog;
- [ ] BLOCKED routing;
- [ ] `NEEDS_USER` escalation;
- [ ] resource locks;
- [ ] file-scope overlap heuristic;
- [ ] scheduler decision log.

### Scheduler invariant

Никогда не назначать две задачи одновременно, если policy считает их mutually exclusive.

### DoD

На synthetic project минимум 3 независимые задачи одновременно выполняются тремя worker-чатами; зависимая четвёртая запускается только после выполнения prerequisites.

---

## Phase 6 — Git Task Isolation

**Цель:** каждая рабочая задача оставляет проверяемый Git-артефакт и не портит соседнюю работу.

### Реализация

- [ ] branch naming convention;
- [ ] base SHA snapshot;
- [ ] branch metadata в task/run;
- [ ] worker instruction запрещает direct push в target branch;
- [ ] commit SHA validation;
- [ ] changed-files validation against scope;
- [ ] detect unexpected target-branch movement;
- [ ] branch freshness check;
- [ ] cleanup policy для abandoned runs;
- [ ] task branch provenance в event log.

### Safety

Если worker утверждает `DONE`, но commit/branch нельзя подтвердить:

```text
DONE_BY_WORKER -> ARTIFACT_INVALID
```

а не `APPROVED`.

### DoD

Каждая code task имеет отдельную ветку и проверяемый commit. Никакой worker не пишет напрямую в protected target branch.

---

## Phase 7 — Review Loop

**Цель:** отделить «worker закончил» от «изменение принято».

### Реализация

- [ ] Reviewer role;
- [ ] review packet;
- [ ] acceptance criteria comparison;
- [ ] diff scope check;
- [ ] `APPROVED/CHANGES_REQUIRED`;
- [ ] structured review comments;
- [ ] rework run creation;
- [ ] max review iterations;
- [ ] escalation при цикле review;
- [ ] optional specialized reviewer selection.

### Review packet

Reviewer получает только необходимый контекст:

```text
Task definition
Acceptance criteria
Relevant architecture rules
Worker summary
Diff/commit
Test output
Known limitations
```

Не нужно засорять Reviewer полной историей worker-чата.

### DoD

Задача с намеренно нарушенным acceptance criterion гарантированно возвращается на rework и не может перейти в integration через обычный `DONE`.

---

## Phase 8 — Integrator + Semantic Conflicts

**Цель:** безопасно собирать параллельные ветки в единый результат.

### Реализация

- [ ] Integrator role allocation;
- [ ] merge conflict event;
- [ ] integration branch;
- [ ] deterministic merge order;
- [ ] integration tests;
- [ ] semantic conflict classification;
- [ ] identify responsible upstream tasks;
- [ ] reopen task / create repair task;
- [ ] integration summary;
- [ ] final target branch policy.

### Merge ordering

В первую очередь интегрировать:

- фундаментальные API/schema tasks;
- затем consumers;
- затем isolated docs/tests where appropriate.

DAG должен помогать определить порядок, а не timestamp окончания worker.

### DoD

Система проходит два сценария:

1. реальный текстовый merge conflict;
2. clean merge + падающие integration tests из-за semantic incompatibility.

В обоих случаях создаётся корректный remediation path.

---

## Phase 9 — Pause / Resume / Crash Recovery

**Цель:** сделать Orchestra реально usable для долгой работы.

### 9.1. Pause semantics

`Pause`:

- не выдавать новые tasks;
- разрешить текущим ChatGPT generations закончиться;
- сохранить ответы/events;
- не начинать новые integrations;
- перевести project в `PAUSED` после достижения safe point.

### 9.2. Stop Now semantics

`Stop Now`:

- прекратить новые prompts;
- по возможности остановить активные generations;
- сохранить snapshot;
- пометить interrupted runs;
- не считать interrupted worker завершившим task.

### 9.3. Resume algorithm

```text
Load persisted project
    |
    v
Validate schema version
    |
    v
Reconnect known tabs
    |
    +--> recreate missing replaceable worker tabs
    |
    v
Reconcile active runs
    |
    v
Reconcile Git branch/commit state
    |
    v
Reject stale events
    |
    v
Rebuild runnable queue
    |
    v
Resume scheduler
```

### Recovery policy

После crash никакое необратимое действие не выполняется только потому, что «вероятно раньше оно не успело выполниться».

Сначала reconciliation, затем действие.

### DoD

Acceptance test:

1. запустить проект с минимум 3 active workers;
2. принудительно закрыть браузер;
3. открыть снова;
4. нажать Resume;
5. получить корректное продолжение без duplicate task assignment/merge/event side effect.

Это один из главных release gates проекта.

---

## Phase 10 — Dashboard / Observability

**Цель:** пользователь понимает происходящее без чтения пяти вкладок.

### Dashboard v1

Показывает:

```text
Project status
Goal
Repository / base SHA

DAG
  T1 VERIFIED
  T2 RUNNING  -> worker-2
  T3 BLOCKED  -> waiting T2
  T4 REVIEWING

Agents
  Lead      BUSY
  Worker-1  IDLE
  Worker-2  RUNNING T2
  Worker-3  OFFLINE
  Worker-4  REVIEWING T4

Recent events
Warnings
User actions required
```

### Возможности

- [ ] task details;
- [ ] event timeline;
- [ ] agent health;
- [ ] filter by severity;
- [ ] open corresponding chat;
- [ ] pause/resume;
- [ ] retry task;
- [ ] cancel task;
- [ ] force review;
- [ ] change priority;
- [ ] reassign worker;
- [ ] inspect reasons scheduler не запускает task.

### DoD

Пользователю не нужно переключаться по worker tabs, чтобы понять общий статус проекта.

---

## Phase 11 — Context Management

**Цель:** не уничтожить качество агентов бесконечной историей.

### Реализация

- [ ] Lead state summary;
- [ ] worker task packet;
- [ ] context budget policy;
- [ ] summarize completed tasks;
- [ ] decisions register;
- [ ] fresh worker replacement;
- [ ] context refresh after N tasks/tokens/iterations;
- [ ] не пересылать полный worker transcript другим агентам;
- [ ] provenance links вместо копирования больших логов.

### Lead summary example

```text
Project P12
Base: 9af...
Verified: T1,T2,T4
Running: T6(worker-2), T7(worker-3)
Blocked: T8 waiting T6
Integration health: green
Known decision: refresh tokens rotate on every use
Open risk: migration backward compatibility
```

### DoD

Lead может быть заменён новым чатом на основании persisted summary + project artifacts без потери критичного состояния.

---

## Phase 12 — Reliability and Safety Hardening

**Цель:** система fail-closed там, где автоматическое продолжение опасно.

### Ограничения

Ввести budgets:

- max task retries;
- max review loops;
- max integration repair loops;
- max continuous runtime;
- max agents;
- max protocol errors;
- max unknown state transitions.

### Circuit breakers

Автоматически `PAUSE + NEEDS_USER`, если:

- target branch неожиданно изменился;
- task scope нарушен существенно;
- повторяются protocol errors;
- один task циклически возвращается на rework;
- Git state не удаётся reconciliation;
- несколько агентов дают противоречивые project assumptions;
- нет progress длительное время;
- repository access потерян.

### Permissions

- минимальные extension permissions;
- никакого произвольного чтения всех страниц;
- project scope ограничен явно выбранными ChatGPT tabs;
- sensitive values не писать в event logs;
- redact known token/password patterns;
- export/debug logs по явному действию пользователя.

### DoD

Набор chaos tests не приводит к автоматическому destructive action в неизвестном состоянии.

---

## Phase 13 — Test Infrastructure + CI

**Цель:** DOM-зависимое расширение нельзя безопасно развивать только ручным тестом.

### Unit tests

- protocol parser;
- reducer/state machine;
- scheduler;
- DAG validator;
- conflict heuristic;
- idempotency;
- persistence migrations;
- recovery planner.

### Integration tests

С fake ChatGPT adapter:

- несколько workers;
- delayed response;
- duplicate response;
- malformed response;
- worker disappearing;
- review rejection;
- conflict resolution;
- pause during generation;
- crash/restart.

### Browser/E2E tests

По возможности Playwright/Chromium fixtures для extension UI и mock HTML ChatGPT page.

Не полагаться в CI на настоящий production ChatGPT DOM для каждого теста — это будет flaky и зависеть от аккаунта/сети.

### Selector contract tests

Хранить HTML fixtures основных состояний:

- idle;
- generating;
- completed;
- error;
- composer occupied;
- disabled send;
- login/access issue.

### CI gates

PR нельзя считать green без:

```text
lint
unit
integration
manifest validation
protocol schema tests
```

### DoD

Core scheduler/recovery можно тестировать вообще без браузера и без ChatGPT.

---

## Phase 14 — First Alpha Release

**Цель:** ограниченный, но честно работающий end-to-end продукт.

### Alpha scope

Поддерживается:

- один проект одновременно;
- 1 Lead;
- до 4 workers;
- Planner/Critic pipeline;
- DAG;
- parallel task scheduling;
- protocol v1;
- separate task branches;
- review loop;
- Integrator;
- Pause/Resume;
- crash recovery;
- dashboard;
- manual final merge approval.

Не обещается:

- полная автономность для любых репозиториев;
- 100% conflict-free operation;
- long-running unattended days without intervention;
- работа со всеми браузерами;
- все Git hosting providers.

### Release gate

Перед alpha необходимо успешно пройти минимум следующие сценарии:

1. **Parallel Happy Path** — 4 независимые задачи, затем integration.
2. **Dependency Path** — downstream task не стартует раньше prerequisite.
3. **Review Rework** — reviewer возвращает task, worker исправляет.
4. **Text Conflict** — Integrator решает/эскалирует Git conflict.
5. **Semantic Conflict** — merge clean, tests fail, создаётся remediation.
6. **Worker Death** — закрыть worker tab, task корректно recovery/reassign.
7. **Duplicate DONE** — событие не вызывает повторный side effect.
8. **Browser Restart** — проект восстанавливается после полного restart.
9. **Pause/Resume** — pause достигает safe point и корректно продолжается.
10. **User Required** — агент запрашивает решение, scheduler не маскирует блокер.

---

# 12. Prompt architecture

Prompts должны быть версионируемыми ресурсами проекта, а не строками, раскиданными по JS.

Рекомендуемая структура:

```text
prompts/
  common/
    protocol.md
    safety.md
  lead/
    bootstrap.md
    final-review.md
  planner/
    discovery.md
    plan.md
    critique.md
    decompose.md
  worker/
    task.md
    rework.md
  reviewer/
    review.md
  integrator/
    integrate.md
    repair.md
```

Каждый prompt имеет version/id.

Event log должен знать, с какой prompt version выполнялся run.

Это важно для воспроизводимости: изменение prompt может полностью изменить поведение агентов даже при неизменном JS.

---

# 13. AGENTS.md contract

`AGENTS.md` должен содержать долговечные инструкции, доступные любому агенту:

- архитектура;
- conventions;
- build/test commands;
- repository-specific rules;
- запрещённые действия;
- Git policy;
- definition of done;
- protocol expectations;
- границы автономности.

Но runtime assignment не должен жить только там.

Плохо:

```text
Worker 2 сейчас делает T17.
```

Хорошо для `AGENTS.md`:

```text
Workers modify only the scope assigned by Orchestra.
Workers never push directly to main.
Every code task must provide verification evidence.
```

Текущее назначение хранится в state store/task graph.

---

# 14. Состояния Agent

Рекомендуемая machine state:

```text
UNBOUND
CONNECTING
IDLE
ASSIGNED
RUNNING
WAITING_RESPONSE
BLOCKED
REVIEWING
INTEGRATING
PAUSED
ERROR
OFFLINE
RETIRED
```

Инварианты:

- один agent одновременно имеет максимум один active task/run;
- один run имеет максимум одного owner-agent;
- `OFFLINE` не считается task failure немедленно;
- после reconnect agent должен доказать соответствие текущему `runId`;
- stale tab не получает новые команды.

---

# 15. Event log

Минимальная запись:

```json
{
  "id": "evt-000091",
  "ts": 0,
  "projectId": "P12",
  "actor": "agent-03",
  "type": "TASK_DONE",
  "taskId": "T17",
  "runId": "R3",
  "payload": {
    "commit": "abc123"
  }
}
```

Event log нужен не только для debug.

Он обеспечивает:

- recovery;
- audit;
- объяснение scheduler decisions;
- поиск duplicate actions;
- последующий replay для отладки;
- метрики качества.

Архитектура должна стремиться к тому, чтобы project state можно было восстановить из snapshot + событий после snapshot.

---

# 16. Persistence and migrations

Состояние будет меняться между версиями extension.

С первого дня нужен:

```text
schemaVersion
```

и migrations:

```text
v1 -> v2
v2 -> v3
```

Нельзя просто менять shape объекта в `chrome.storage.local`, иначе обновление extension однажды сломает paused projects.

Migration должна:

- быть идемпотентной;
- backup старый snapshot;
- fail closed;
- не продолжать scheduler при неуспешной миграции.

---

# 17. Error taxonomy

Не использовать один универсальный `ERROR`.

Минимальные классы:

```text
PROTOCOL_ERROR
CHAT_UI_ERROR
AGENT_LOGIC_ERROR
TASK_EXECUTION_ERROR
ARTIFACT_ERROR
GIT_ERROR
MERGE_CONFLICT
INTEGRATION_ERROR
REVIEW_ERROR
TIMEOUT
AUTH_ERROR
PERMISSION_ERROR
RECOVERY_ERROR
USER_INPUT_REQUIRED
```

У каждого класса своя policy:

- retry;
- reassign;
- send to Integrator;
- ask Lead;
- ask user;
- pause whole project.

---

# 18. Retry policy

Retry должен быть ограниченным и осмысленным.

Плохо:

```text
ERROR -> "попробуй ещё раз" бесконечно
```

Хорошо:

```text
attempt 1 -> same agent with error context
attempt 2 -> revised instruction / fresh context
attempt 3 -> reassign or escalate
```

Retry counter хранится в run/task state, а не в памяти чата.

Для deterministic errors повтор без изменения входа вообще не нужен.

---

# 19. Human-in-the-loop gates

Настройки autonomy level:

### Level 0 — Observe

Orchestra только строит план и предлагает назначения.

### Level 1 — Execute, manual merge

Workers выполняют задачи автоматически, но merge требует подтверждения.

### Level 2 — Auto integrate, manual final merge

Task branches интегрируются автоматически после review/tests, финальное попадание в target branch подтверждает пользователь.

### Level 3 — Full allowed automation

Автоматический final merge только если все configured gates green.

Для alpha рекомендуется Level 1–2.

---

# 20. Метрики, которые стоит собирать локально

Для улучшения scheduler и оценки идеи полезны:

- project completion rate;
- tasks completed;
- average attempts per task;
- review rejection rate;
- merge conflict rate;
- semantic integration failure rate;
- worker utilization;
- average blocked time;
- number of human interventions;
- duplicate events prevented;
- recovery success rate;
- wall-clock speedup vs sequential estimate;
- task scope violation rate.

По умолчанию эти данные могут оставаться локальными. Любая внешняя telemetry должна быть отдельным opt-in решением.

---

# 21. Suggested internal module boundaries

```text
src/
  core/
    project-reducer.js
    task-reducer.js
    agent-reducer.js
    invariants.js
  orchestrator/
    orchestrator.js
    command-router.js
  scheduler/
    scheduler.js
    runnable.js
    priorities.js
    conflicts.js
  protocol/
    parser.js
    validator.js
    events.js
  persistence/
    store.js
    migrations.js
    snapshots.js
  tabs/
    registry.js
    lifecycle.js
  adapters/
    chatgpt/
      selectors.js
      generation.js
      composer.js
      messages.js
    git/
      provider.js
  prompts/
  ui/
```

Главное требование: `scheduler`, reducers и protocol parser должны тестироваться без Chrome DOM.

---

# 22. Архитектурные инварианты

Эти правила должны быть закреплены тестами:

1. `PAUSED` project не выдаёт новые assignments.
2. Один agent не выполняет два active runs.
3. Один run не имеет двух owner agents одновременно.
4. Duplicate `eventId` не производит второй side effect.
5. Stale `runId` не может завершить новую попытку той же task.
6. `DONE_BY_WORKER` не равен `VERIFIED`.
7. Task не становится runnable до выполнения dependencies.
8. Worker не может самостоятельно перевести task в `MERGED`.
9. Unknown protocol event не вызывает destructive action.
10. Recovery сначала reconciles state, потом продолжает scheduler.
11. Direct push в protected target branch не является нормальным worker path.
12. Project state не зависит от существования конкретной ChatGPT tab.
13. Закрытие tab не удаляет task/run history.
14. Неуспешная state migration останавливает проект.
15. User `Stop Now` всегда имеет приоритет над scheduler.

---

# 23. Что не стоит делать

### Не строить orchestration через копирование текста между чатами

Текст — payload, но routing и state должны быть машинными.

### Не давать Lead полный transcript всех workers

Передавать summaries + artifacts + relevant evidence.

### Не назначать фиксированный «пятый чат конфликтов» навсегда

Использовать dynamic role allocation.

### Не считать Git merge conflict единственным видом конфликта

Semantic conflicts важнее.

### Не начинать с собственного backend

Сначала доказать orchestration model внутри extension.

### Не делать бесконечные retries

Всегда budget + escalation.

### Не связывать проект навечно с текущим DOM ChatGPT

ChatGPT UI должен быть adapter boundary, чтобы позже можно было добавить другие исполнительные adapters.

---

# 24. Приоритет реализации

Если разработчиков мало, порядок должен быть таким:

```text
P0  State model + reducers + protocol
P0  Service worker + tab registry
P0  Adapter extraction
P0  Multi-tab targeted messaging
P0  Idempotency
P1  Project bootstrap
P1  Planner/Critic/Decomposer
P1  DAG scheduler
P1  Parallel workers
P1  Pause/Resume
P1  Crash recovery
P1  Git branch isolation
P1  Review loop
P1  Integrator
P2  Dashboard
P2  Context rotation
P2  conflict-aware scheduling improvements
P2  metrics
P3  additional providers/browsers
```

Почему recovery так высоко: автономная система, которую нельзя безопасно остановить и продолжить, останется демонстрацией, а не инструментом.

---

# 25. Рекомендуемые первые реальные milestones

## Milestone A — Multi-tab foundation

Результат:

> Один controller управляет 1 Lead + 2 Workers и адресно отправляет/получает protocol events.

Не делать ещё Planner и Git automation.

## Milestone B — Deterministic task engine

Результат:

> Заранее вручную заданный DAG из 5 synthetic tasks выполняется правильным scheduler order несколькими fake/real workers.

Это отделяет проблемы orchestration от качества planning.

## Milestone C — Planning automation

Результат:

> Lead pipeline сам строит DAG из user goal + repository context.

## Milestone D — Git artifacts + review

Результат:

> Worker branches, commits, review/rework, integration.

## Milestone E — Recovery

Результат:

> Browser kill/restart не ломает project.

## Milestone F — Alpha UX

Результат:

> Dashboard, safe controls, install docs, release package.

---

# 26. Самый важный end-to-end сценарий

Разработку следует постоянно проверять на одном reference scenario.

Пример:

> «В существующий web-проект добавить OAuth login, backend callback, frontend button, tests и documentation».

Хороший DAG может выглядеть так:

```text
T1 Discover existing auth architecture
       |
       v
T2 Define OAuth contract/config
      / \
     v   v
T3 Backend provider integration    T4 Frontend login flow
     |                              |
     v                              v
T5 Backend tests                  T6 Frontend tests
      \                           /
       \                         /
        v                       v
          T7 Integration verification
                    |
                    v
                T8 Documentation
```

Scheduler должен видеть реальную параллельность `T3/T4`, а затем `T5/T6`.

После выполнения система обязана иметь доказуемую цепочку:

```text
user goal
-> approved plan
-> tasks
-> assignments
-> commits
-> reviews
-> integration
-> tests
-> final report
```

Если такая цепочка не восстанавливается после restart, архитектура ещё не закончена.

---

# 27. Критерий успеха проекта

ChatGPT Orchestra можно считать состоявшимся, когда пользователь действительно может:

```text
1. дать цель;
2. дать репозиторий;
3. запустить Orchestra;
4. увидеть, что несколько независимых задач выполняются параллельно;
5. закрыть браузер посреди работы;
6. восстановить проект;
7. увидеть review и integration;
8. получить проверяемый Git-результат;
9. понять, почему система приняла каждое важное решение;
10. вмешаться только там, где автоматическое продолжение небезопасно.
```

Главная ценность проекта — не количество открытых ChatGPT-вкладок.

Главная ценность:

> **устойчивое параллельное выполнение инженерной работы через независимых AI-исполнителей с централизованным состоянием, контролем зависимостей, проверкой результата и безопасным восстановлением.**

---

# 28. Ближайшая следующая задача

После Phase 1 следующая implementation-задача:

> **Phase 2 — introduce a Manifest V3 service-worker orchestrator with a persistent tab registry and targeted messaging, while keeping ChatGPT DOM details behind the Phase 1 adapter boundary.**

Сначала нужно доказать управление несколькими адресуемыми вкладками и их lifecycle/reconnect; только после этого переходить к полноценному Orchestra Protocol/Event Bus из Phase 3.
