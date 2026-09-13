<div align="center">

# ChatGPT Orchestra

Browser-based multi-agent orchestration for ChatGPT coding workflows.

[![Platform](https://img.shields.io/badge/platform-Microsoft%20Edge-0A7EA4?style=for-the-badge)](#требования-и-permissions)
[![Version](https://img.shields.io/badge/version-2.0.0--alpha.11-orange?style=for-the-badge)](CHANGELOG.md)
[![License](https://img.shields.io/github/license/VadimAlekseyevich/ChatGPT-Orchestra?style=for-the-badge&label=license)](LICENSE)

[Roadmap](ROADMAP.md) · [Changelog](CHANGELOG.md) · [Документация](docs/README.md) · [Issues](../../issues)

</div>

---

## Идея

**ChatGPT Orchestra** — Manifest V3 extension, которая превращает несколько ChatGPT-чатов в управляемый оркестр coding-agent'ов с централизованным состоянием, формальным event protocol, staged planning, conflict-aware scheduling, Git isolation, независимым review, verified integration и deterministic recovery.

Ключевой принцип: **чаты — исполнители, а не источник истины**. Project state, task/run/review/integration state, recovery lifecycle, event identity, Git provenance и scheduler decisions принадлежат Orchestrator Core.

Начиная с alpha.11 Core постепенно отвязывается от MV3 APIs через platform contracts и Orchestrator API, чтобы затем переноситься в отдельное desktop-приложение. Extension остаётся рабочей reference-реализацией и временным companion bridge до достижения desktop parity.

Полная целевая архитектура: [`ROADMAP.md`](ROADMAP.md).

---

## Текущий статус

Текущая prerelease-версия — **`2.0.0-alpha.11`**.

Реализованы:

- Phase 1 — deterministic ChatGPT DOM adapter и completion detection;
- Phase 2 — MV3 service worker и persistent agent/tab registry;
- Phase 3 — Orchestra Protocol v1 + persisted Event Bus;
- Phase 4 — Project Bootstrap, Planner/Critic и deterministic DAG validation;
- Phase 5 — conflict-aware parallel scheduler;
- Phase 6 — per-run Git task isolation и independent artifact validation;
- Phase 7 — independent Reviewer, structured approval и bounded rework loop;
- Phase 8 — dynamic Integrator, deterministic branch composition и semantic conflict remediation;
- Phase 9 — safe-point Pause, Stop Now, reconcile-before-resume и browser/service-worker crash recovery;
- Phase 10 — platform contracts, extension adapters и portable Orchestrator API v1.

Текущий execution pipeline:

```text
User goal + GitHub repository
          ↓
Planning / Critic / DAG validation
          ↓
READY
          ↓
parallel Worker runs
          ↓
Git artifact validation
          ↓
DONE_BY_WORKER
          ↓
independent Reviewer
       ↙       ↘
CHANGES_REQUIRED  REVIEW_APPROVED
       ↓               ↓
new rework run       APPROVED
       └───────┐        ↓
               └── dependency unlock
                        ↓
              READY_FOR_INTEGRATION
                        ↓
              dynamic Integrator
                        ↓
          deterministic --no-ff merges
                  ↙             ↘
          text conflict     semantic conflict
                  ↓             ↓
             bounded repair task
                  └──────┬──────┘
                         ↓
              integration verification
                         ↓
                INTEGRATION_VERIFIED
```

Любая long-running стадия дополнительно управляется persisted recovery control plane:

```text
RUNNING
  ├─ Pause ───────→ PAUSING → safe point → PAUSED
  ├─ Stop Now ────→ STOPPING → interrupted snapshot → STOPPED
  └─ crash/restart → RECOVERING
                       ├─ continuity intact → RUNNING
                       └─ ambiguity/lost tabs → RECOVERY_REQUIRED → Resume
```

`INTEGRATION_VERIFIED` означает: approved task commits собраны в отдельной remote integration branch, target branch осталась на immutable base, ancestry/merge order/changed files проверены независимо, а integration verification commands имеют PASS evidence. Это **не direct merge в target branch**.

---

## Project Bootstrap и Planning

Popup принимает GitHub repository URL вида `https://github.com/owner/repo` и цель проекта. Пользователь явно назначает нужный ChatGPT tab как Lead.

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
deterministic validation
  ↓
READY
```

Project получает `READY` только после программной проверки dependencies, cycles, scope, acceptance criteria, verification, complexity, migration safety и objective coverage.

Большие planning artifacts передаются отдельно от маленького `@@ORCH` envelope через bounded artifact block.

Подробности: [`docs/phase-4-project-planning.md`](docs/phase-4-project-planning.md).

---

## Scheduler + Parallel Workers

После `READY` пользователь выбирает `maxWorkers` и запускает execution.

Scheduler хранит mutable task/run state отдельно от approved DAG. Он учитывает:

- dependencies;
- downstream unlock potential;
- business priority;
- file-scope overlap;
- explicit/inferred resource locks;
- Worker availability;
- retry budget;
- watchdog/heartbeat;
- active Reviewer slots.

Пара tasks не запускается одновременно, если conflict policy считает их mutually exclusive.

После Phase 7 dependency считается выполненной только при:

```text
status == APPROVED
```

Worker `DONE`, Git-valid artifact, `DONE_BY_WORKER`, `REVIEW_PENDING` и `REVIEWING` не разблокируют downstream-задачи.

Подробности: [`docs/phase-5-scheduler.md`](docs/phase-5-scheduler.md).

---

## Git Task Isolation

Перед первым dispatch Orchestra снимает immutable snapshot target branch:

```text
targetBranch + baseSha
```

Каждый mutating run получает отдельную ветку:

```text
orchestra/<projectId>/<taskId>/<runId>
```

Worker не имеет права push/commit напрямую в target branch. Перед принятием Worker `DONE` service worker независимо проверяет через GitHub REST:

- target branch всё ещё находится на captured base;
- task branch существует;
- remote branch head совпадает с reported full commit SHA;
- branch основана на ожидаемом base;
- ahead/behind state допустим;
- реальные changed files совпадают с Worker report;
- changed files соответствуют `scope.allow` / `scope.deny`.

Если артефакт нельзя проверить, задача не проходит дальше.

Rework run получает новый `runId` и новую branch identity. Для mutating rework он стартует от предыдущего reviewed task commit, сохраняя сделанную работу, но всё ещё валидируется относительно immutable project base.

Подробности: [`docs/phase-6-git-task-isolation.md`](docs/phase-6-git-task-isolation.md).

---

## Independent Review Loop

После Git-valid Worker completion task становится:

```text
DONE_BY_WORKER → REVIEW_PENDING → REVIEWING
```

Reviewer — динамическая роль. Свободный Worker tab может временно стать Reviewer, но **автор конкретного Worker run никогда не является допустимым Reviewer**.

Review packet содержит только необходимый bounded context:

- task definition;
- acceptance criteria;
- relevant architecture/repository rules;
- Worker summary;
- tests performed;
- known limitations;
- independently validated Git artifact;
- bounded Git diff;
- scope + verification commands.

Полная история Worker-чата Reviewer'у не передаётся.

### REVIEW_APPROVED

Approval принимается только если structured payload:

- покрывает каждый acceptance criterion точным текстом;
- даёт `PASS` + evidence для каждого criterion;
- даёт `scopeCheck: PASS` + evidence;
- даёт `testsAssessment: PASS | WAIVED` + evidence;
- не содержит blocking/high/critical issues;
- не содержит required changes.

Тогда task становится `APPROVED` и может разблокировать downstream DAG.

### CHANGES_REQUIRED

Если criterion нарушен или evidence недостаточно:

```text
CHANGES_REQUIRED
      ↓
READY
      ↓
new runId + new branch
      ↓
rework instructions from structured review
      ↓
new review
```

По умолчанию максимум — 3 review iterations. На лимите Orchestra останавливает цикл и переводит execution в `NEEDS_USER`.

Если Reviewer tab исчез, старый review становится abandoned, а retry получает новый `reviewId`; поздний ответ старого review не может принять replacement review.

Подробности: [`docs/phase-7-review-loop.md`](docs/phase-7-review-loop.md).

---

## Integrator + Semantic Conflicts

Когда все tasks имеют `APPROVED`, Orchestra автоматически выделяет свободный Worker tab как временный Integrator.

Каждая integration attempt получает отдельную ветку:

```text
orchestra/<projectId>/integration/<integrationRunId>
```

Order выводится из DAG, а не времени завершения Worker'ов. Dependencies всегда идут раньше consumers; среди одновременно доступных tasks schema/API/protocol/core work имеет приоритет, затем implementation, затем isolated tests/docs.

Для composition Integrator обязан использовать:

```bash
git merge --no-ff --no-edit <task-branch>
```

Squash/rebase/cherry-pick task commits запрещены. Это позволяет service worker независимо доказать, что каждый approved commit остался ancestor integration head и что second-parent merge order совпал с deterministic order.

### Text conflict

Integrator abort'ит конфликтующий merge и отправляет structured `CONFLICT` с exact merged prefix, current task и unresolved files. Orchestra атрибутирует upstream tasks по current task + approved artifact file ownership и создаёт bounded `integration-repair-*` task.

### Semantic conflict

Если Git merges clean, но integration checks падают из-за совместимости approved changes, Integrator отправляет `CONFLICT` с `conflictType=semantic`, failed-check evidence и explicit `responsibleTaskIds`. Orchestra не угадывает semantic responsibility при отсутствии evidence.

После bounded repair все integration checks запускаются снова. Default repair budget — 2; exhaustion → `NEEDS_USER`.

### Независимая финальная проверка

Перед `INTEGRATION_VERIFIED` service worker проверяет:

- target branch всё ещё равна captured base SHA;
- integration remote head совпадает с reported commit;
- merge base равна base snapshot;
- changedFiles совпадают с GitHub compare;
- integration не меняет файлы вне union approved artifacts;
- каждый approved task commit является ancestor integration head;
- first-parent merge order совпадает с deterministic order;
- каждый required integration command имеет `PASS` evidence.

Alpha.11 сохраняет policy `integration_branch_only`: target branch расширение напрямую не изменяет.

Подробности: [`docs/phase-8-integrator.md`](docs/phase-8-integrator.md).

---

## Pause / Resume / Crash Recovery

Phase 9 добавляет отдельный `RecoveryStore` поверх Planning/Scheduler/Review/Integration. Underlying work state не переписывается в искусственный `PAUSED`: recovery lifecycle хранится отдельно и управляет единым dispatch gate.

### Pause

`Pause` сразу запрещает новые prompts, но уже идущие generations могут закончиться и сохранить events/artifacts. После исчезновения active planning/Worker/Reviewer/Integrator generation Orchestra достигает safe point и становится `PAUSED`.

### Stop Now

`Stop Now` best-effort отправляет `STOP_GENERATION`, затем:

- Worker run → `INTERRUPTED`, а не completion;
- active Review requeue'ится с fresh `reviewId`;
- active Integration run abandon'ится и не переиспользуется;
- active Planning stage получает interrupted marker и fresh run после Resume;
- late `DONE / REVIEW_* / CONFLICT` во время `STOPPING/STOPPED` остаются audit-only и не применяются к state machines.

### Resume

Resume всегда выполняет reconciliation **до** открытия dispatch:

1. reconcile tabs;
2. missing Worker records удаляются из live registry;
3. replacement Worker tabs получают fresh agent IDs;
4. target/base Git snapshot проверяется повторно;
5. task branches reconciles с persisted runs;
6. безопасный in-scope remote progress может стать стартовым commit fresh run;
7. reviews/integration identities reconciles или заменяются;
8. protocol contexts перестраиваются из persisted state;
9. только затем recovery возвращается в `RUNNING`.

Небезопасный или неоднозначный state остаётся `RECOVERY_REQUIRED`.

При обычном MV3 service-worker restart с живыми ChatGPT tabs Orchestra может auto-reconcile и продолжить без повторной выдачи active work. При полном browser restart и потерянных tabs требуется explicit Resume.

Подробности: [`docs/phase-9-pause-resume-recovery.md`](docs/phase-9-pause-resume-recovery.md).

---

## Platform Boundary + Orchestrator API

Phase 10 вводит переносимую границу между Core и browser host:

```text
Chrome / Edge
    │
    ├─ ExtensionAgentRuntime
    ├─ ChromeStorageStateStore
    └─ ChromeAlarmRuntime
              │
              ▼
       Orchestrator API v1
              │
              ▼
 Planning / Scheduler / Review / Integration / Recovery / EventBus
```

Основные contracts:

- `AgentRuntime` — session lifecycle, prompt/stop routing, heartbeat и logical agent identity;
- `StateStore` — key/value persistence backend;
- `TimerRuntime` — recurring watchdog scheduling;
- `OrchestratorApi` — platform-neutral command/query surface для popup и будущего desktop IPC.

`ServiceWorkerOrchestrator` больше не вызывает `chrome.tabs` напрямую. Browser-specific APIs собраны в extension adapters и composition root. Для browser-free tests доступны `FakeAgentRuntime`, `MemoryStateStore` и `DeterministicTimerRuntime`.

Persisted `tabId` пока остаётся compatibility metadata текущей extension schema. Его удаление из portable durable state и state migrations относятся к Phase 11.

Подробности: [`docs/phase-10-platform-boundary.md`](docs/phase-10-platform-boundary.md).

---

## Orchestra Protocol v1

Protocol event — последняя непустая строка assistant response:

```text
@@ORCH {"v":1,"event":"DONE","projectId":"P1","taskId":"T1","runId":"R1","agentId":"A1","eventId":"E1","sequence":1,"payload":{}}
```

Identity включает:

```text
projectId
taskId
runId
agentId
eventId
sequence
```

Event Bus обеспечивает duplicate suppression, `event_id_collision`, monotonic sequence, runtime sender ↔ agent validation, stale project/task/run rejection и persisted audit.

Review использует тот же Protocol v1, но `runId` равен отдельному `reviewId`, а event — `REVIEW_APPROVED` или `CHANGES_REQUIRED`.

Integrator использует `taskId=integration`; все integration events требуют exact bound protocol context до eventId reservation. Основные события — `CONFLICT`, `DONE`, `BLOCKED`, `ERROR`, `NEEDS_USER`.

Контракт: [`docs/phase-3-protocol-v1.md`](docs/phase-3-protocol-v1.md).

---

## Agent Pool

Popup умеет:

- явно зарегистрировать текущий ChatGPT tab как Lead;
- создать до четырёх Worker tabs;
- показывать `CONNECTING / IDLE / BUSY / ERROR / OFFLINE`;
- восстанавливать known agent identity после reload;
- отправлять prompt конкретному `agentId`;
- динамически использовать idle Worker как Reviewer;
- динамически использовать idle Worker как Integrator после полного approval DAG;
- управлять `Pause / Resume / Stop Now` для активного проекта.

Обычные ChatGPT tabs не становятся агентами автоматически.

Если `maxWorkers=1`, Orchestra всё равно держит второй connected Worker tab для независимой проверки, но concurrency budget остаётся один active role.

---

## Safety invariants alpha.11

- boot reconciliation закрывает dispatch до `bootReady=true`;
- Pause запрещает новые prompts до safe point и во всём `PAUSED`;
- Stop Now не превращает interrupted Worker в completion;
- late state-changing events через Stop boundary audit'ятся, но не применяются;
- replacement browser tabs получают fresh Worker identities;
- recovered Git progress принимается только после base/scope checks;
- обычный Worker `DONE` не означает acceptance;
- mutating Worker result не проходит без independently validated Git artifact;
- author agent не может review собственный run;
- dependency unlock требует `APPROVED`;
- `APPROVED` mutating task без canonical Git artifact не допускается к integration;
- integration events требуют exact bound protocol context;
- Integrator использует deterministic `--no-ff` merge order;
- target branch movement останавливает execution/recovery fail-closed;
- final integration report не принимается без remote ancestry/merge-history validation;
- runtime connectivity и agent health разделены: существующая `ERROR` session не считается исчезнувшей;
- alpha.11 не пишет target branch напрямую.

---

## Архитектура alpha.11

```text
background/
  service-worker.js
  orchestrator.js
  orchestrator-api.js
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
  review-store.js
  review-engine.js
  integration-policy.js
  integration-store.js
  integration-engine.js
  integration-recovery.js
  recovery-store.js
  recovery-controller.js
  recovery-hooks.js
  recovery-stop-guards.js

platform/
  contracts.js
  extension-runtime.js
  fake-runtime.js

protocol/
  orchestra-protocol.js

prompts/
  planning-prompts.js
  worker-prompts.js
  review-prompts.js
  integration-prompts.js
```

`ProjectStore` хранит project/approved DAG. `SchedulerStore` — mutable task/run state. `ReviewStore` — review identities/history. `IntegrationStore` — integration attempts/conflicts/repairs/final summary. `RecoveryStore` — persisted lifecycle intent/snapshots. `EventBus` — protocol identity/idempotency. `GitProvider` — independent Git provenance. Platform adapters инкапсулируют browser host, а `OrchestratorApi` становится общей control-plane границей для extension и будущего desktop runtime.

---

## Быстрый старт

```powershell
git clone https://github.com/VadimAlekseyevich/ChatGPT-Orchestra.git
cd ChatGPT-Orchestra
npm test
npm run test:phase10
```

Затем:

1. `edge://extensions/` → Developer mode → Load unpacked;
2. зарегистрируй нужный ChatGPT tab как Lead;
3. укажи repository + project goal;
4. дождись planning status `READY`;
5. выбери Worker slots / maxWorkers;
6. Start Execution;
7. наблюдай Worker → Git validation → independent review → integration;
8. используй Pause для safe-point остановки новых prompts;
9. используй Stop Now для interruption boundary;
10. после browser/service-worker disruption используй Resume и следи за `RECOVERING / RECOVERY_REQUIRED / RUNNING`;
11. финальный успешный execution status — `INTEGRATION_VERIFIED`, target branch остаётся неизменённой.

Runtime extension не требует npm dependencies или build step.

---

## Требования и permissions

- Microsoft Edge + Manifest V3;
- доступ к ChatGPT;
- Node.js 18+ только для development tests.

Manifest permissions:

- `storage` — registry/event/project/scheduler/review/integration/recovery persisted state;
- `tabs` — extension `AgentRuntime` session lifecycle и targeted routing;
- `alarms` — extension `TimerRuntime` watchdog;
- ChatGPT host permissions — content adapter;
- `https://api.github.com/*` — read-only Git artifact/review/integration/recovery validation.

Extension не хранит GitHub credentials и alpha.11 не использует GitHub write API. Git branches/commits создаются назначенными ChatGPT agents через их рабочую Git-среду; extension независимо проверяет remote result.

---

## Roadmap

Завершённый extension foundation и первый migration step:

- Phase 0 — Repository reset / Rename hygiene;
- Phase 1 — Adapter core — `2.0.0-alpha.2`;
- Phase 2 — Service Worker + Tab Registry — `2.0.0-alpha.3`;
- Phase 3 — Protocol v1 + Event Bus — `2.0.0-alpha.4`;
- Phase 4 — Project Planning — `2.0.0-alpha.5`;
- Phase 5 — Parallel Scheduler — `2.0.0-alpha.6`;
- Phase 6 — Git Task Isolation — `2.0.0-alpha.7`;
- Phase 7 — Independent Review Loop — `2.0.0-alpha.8`;
- Phase 8 — Integrator + Semantic Conflicts — `2.0.0-alpha.9`;
- Phase 9 — Pause / Resume / Crash Recovery — `2.0.0-alpha.10`;
- Phase 10 — Platform Boundary + Orchestrator API — `2.0.0-alpha.11`.

Следующие этапы постепенной desktop migration:

- **Phase 11 — Portable Persistence + Project Export/Import — следующий этап;**
- Phase 12 — Portable Dashboard + Observability API;
- Phase 13 — Context Management + Portable Agent Packets;
- Phase 14 — Contract Tests + CI Foundation;
- Phase 15 — Desktop Shell Bootstrap;
- Phase 16 — Desktop Control Plane + Extension Companion Bridge;
- Phase 17 — Local Repository Runtime + Git Worktrees;
- Phase 18 — Direct Desktop ChatGPT AgentRuntime;
- Phase 19 — Desktop Parity + Reliability / Security Hardening;
- Phase 20 — Desktop-first Alpha Release;
- Phase 21 — Post-alpha Cutover / Provider Expansion.

Полная стратегия и migration gates описаны в [`ROADMAP.md`](ROADMAP.md) и [`docs/adr/0009-gradual-desktop-migration.md`](docs/adr/0009-gradual-desktop-migration.md).

---

## Ограничения alpha.11

- `INTEGRATION_VERIFIED` означает verified integration branch, но не automatic promotion в target branch;
- target branch policy остаётся `integration_branch_only`;
- planning Lead после полного browser loss требует явного user reconnect/register;
- recovery не пытается восстановить скрытый model context закрытой ChatGPT вкладки: вместо этого reconciles persisted artifacts и создаёт fresh run identity;
- unauthenticated GitHub REST reconciliation ориентирован на public-readable repositories;
- review и semantic attribution остаются LLM-based quality gates поверх deterministic structural/provenance checks;
- portable persistence schema, SQLite и desktop runtime ещё не реализованы;
- legacy `tabId` остаётся compatibility metadata extension persistence до Phase 11 migration;
- текущий production runtime остаётся Edge extension до прохождения migration phases;
- browser E2E against production ChatGPT DOM остаётся ручным smoke-test.

---

## Документация

- [`ROADMAP.md`](ROADMAP.md)
- [`CHANGELOG.md`](CHANGELOG.md)
- [`docs/phase-3-protocol-v1.md`](docs/phase-3-protocol-v1.md)
- [`docs/phase-4-project-planning.md`](docs/phase-4-project-planning.md)
- [`docs/phase-5-scheduler.md`](docs/phase-5-scheduler.md)
- [`docs/phase-6-git-task-isolation.md`](docs/phase-6-git-task-isolation.md)
- [`docs/phase-7-review-loop.md`](docs/phase-7-review-loop.md)
- [`docs/phase-8-integrator.md`](docs/phase-8-integrator.md)
- [`docs/phase-8-smoke-test.md`](docs/phase-8-smoke-test.md)
- [`docs/phase-9-pause-resume-recovery.md`](docs/phase-9-pause-resume-recovery.md)
- [`docs/phase-9-smoke-test.md`](docs/phase-9-smoke-test.md)
- [`docs/phase-10-platform-boundary.md`](docs/phase-10-platform-boundary.md)
- [`docs/phase-10-smoke-test.md`](docs/phase-10-smoke-test.md)
- [`docs/adr/0009-gradual-desktop-migration.md`](docs/adr/0009-gradual-desktop-migration.md)
- [`docs/adr/0010-platform-contracts-orchestrator-api.md`](docs/adr/0010-platform-contracts-orchestrator-api.md)
- [`docs/adr/`](docs/adr/)
