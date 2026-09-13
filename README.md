<div align="center">

# ChatGPT Orchestra

Browser-based multi-agent orchestration for ChatGPT coding workflows.

[![Platform](https://img.shields.io/badge/platform-Microsoft%20Edge-0A7EA4?style=for-the-badge)](#требования-и-permissions)
[![Version](https://img.shields.io/badge/version-2.0.0--alpha.8-orange?style=for-the-badge)](CHANGELOG.md)
[![License](https://img.shields.io/github/license/VadimAlekseyevich/ChatGPT-Orchestra?style=for-the-badge&label=license)](LICENSE)

[Roadmap](ROADMAP.md) · [Changelog](CHANGELOG.md) · [Документация](docs/README.md) · [Issues](../../issues)

</div>

---

## Идея

**ChatGPT Orchestra** — Manifest V3 extension, которая превращает несколько ChatGPT-чатов в управляемый оркестр coding-agent'ов с централизованным состоянием, формальным event protocol, staged planning, conflict-aware scheduling, Git isolation и независимым review.

Ключевой принцип: **чаты — исполнители, а не источник истины**. Project state, task/run/review state, event identity, Git provenance и scheduler decisions принадлежат Orchestrator Core в service worker.

Полная целевая архитектура: [`ROADMAP.md`](ROADMAP.md).

---

## Текущий статус

Текущая prerelease-версия — **`2.0.0-alpha.8`**.

Реализованы:

- Phase 1 — deterministic ChatGPT DOM adapter и completion detection;
- Phase 2 — MV3 service worker и persistent agent/tab registry;
- Phase 3 — Orchestra Protocol v1 + persisted Event Bus;
- Phase 4 — Project Bootstrap, Planner/Critic и deterministic DAG validation;
- Phase 5 — conflict-aware parallel scheduler;
- Phase 6 — per-run Git task isolation и independent artifact validation;
- Phase 7 — independent Reviewer, structured approval и bounded rework loop.

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
```

`READY_FOR_INTEGRATION` означает: все task artifacts прошли Git validation и независимый review. Это **ещё не merge**. Integration/semantic conflicts — Phase 8.

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

Event Bus обеспечивает duplicate suppression, `event_id_collision`, monotonic sequence, sender tab ↔ agent validation, stale project/task/run rejection и persisted audit.

Review использует тот же Protocol v1, но `runId` равен отдельному `reviewId`, а event — `REVIEW_APPROVED` или `CHANGES_REQUIRED`.

Контракт: [`docs/phase-3-protocol-v1.md`](docs/phase-3-protocol-v1.md).

---

## Agent Pool

Popup умеет:

- явно зарегистрировать текущий ChatGPT tab как Lead;
- создать до четырёх Worker tabs;
- показывать `CONNECTING / IDLE / BUSY / ERROR / OFFLINE`;
- восстанавливать known agent identity после reload;
- отправлять prompt конкретному `agentId`;
- динамически использовать idle Worker как Reviewer.

Обычные ChatGPT tabs не становятся агентами автоматически.

Если `maxWorkers=1`, Orchestra всё равно держит второй connected Worker tab для независимой проверки, но concurrency budget остаётся один active role.

---

## Safety invariants alpha.8

- обычный Worker `DONE` не означает acceptance;
- mutating Worker result не проходит без independently validated Git artifact;
- author agent не может review собственный run;
- incomplete/malformed `REVIEW_APPROVED` fails closed;
- `CHANGES_REQUIRED` не считается completion;
- dependency unlock требует `APPROVED`;
- lost review retry получает fresh `reviewId`;
- target branch movement останавливает execution fail-closed;
- никакая Phase 7 логика не merge'ит task branches и не пишет в target branch.

---

## Архитектура alpha.8

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
  review-store.js
  review-engine.js

protocol/
  orchestra-protocol.js

prompts/
  planning-prompts.js
  worker-prompts.js
  review-prompts.js
```

`ProjectStore` хранит project/approved DAG. `SchedulerStore` — mutable task/run state. `ReviewStore` — review identities/history. `EventBus` — protocol identity/idempotency. `GitProvider` — independent Git provenance. ChatGPT tabs остаются replaceable executor nodes.

---

## Быстрый старт

```powershell
git clone https://github.com/VadimAlekseyevich/ChatGPT-Orchestra.git
cd ChatGPT-Orchestra
npm test
npm run test:phase7
```

Затем:

1. `edge://extensions/` → Developer mode → Load unpacked;
2. зарегистрируй нужный ChatGPT tab как Lead;
3. укажи repository + project goal;
4. дождись planning status `READY`;
5. выбери Worker slots / maxWorkers;
6. Start Execution;
7. наблюдай Worker → Git validation → independent review → rework/approval;
8. после всех approvals ожидай `READY_FOR_INTEGRATION`.

Runtime extension не требует npm dependencies или build step.

---

## Требования и permissions

- Microsoft Edge + Manifest V3;
- доступ к ChatGPT;
- Node.js 18+ только для development tests.

Manifest permissions:

- `storage` — registry/event/project/scheduler/review persisted state;
- `tabs` — agent tab lifecycle и targeted routing;
- `alarms` — scheduler watchdog;
- ChatGPT host permissions — content adapter;
- `https://api.github.com/*` — read-only Git artifact validation/review diff retrieval.

Extension не хранит GitHub credentials и alpha.8 не использует GitHub write API.

---

## Roadmap

- Phase 0 — Repository reset / Rename hygiene;
- Phase 1 — Adapter core — `2.0.0-alpha.2`;
- Phase 2 — Service Worker + Tab Registry — `2.0.0-alpha.3`;
- Phase 3 — Protocol v1 + Event Bus — `2.0.0-alpha.4`;
- Phase 4 — Project Planning — `2.0.0-alpha.5`;
- Phase 5 — Parallel Scheduler — `2.0.0-alpha.6`;
- Phase 6 — Git Task Isolation — `2.0.0-alpha.7`;
- **Phase 7 — Independent Review Loop — `2.0.0-alpha.8`;**
- **Phase 8 — Integrator + Semantic Conflicts — следующий этап;**
- Phase 9+ — recovery, dashboard, context, hardening, CI, alpha release.

---

## Ограничения alpha.8

- `APPROVED` означает review acceptance task artifact, но не integration;
- approved parallel branches могут быть семантически несовместимы до Phase 8;
- merge/rebase/integration branch и final target-branch policy ещё не реализованы;
- general Pause/Resume/reconciliation — Phase 9;
- review остаётся LLM-based quality gate: deterministic validator проверяет структуру verdict, но не может математически доказать semantic correctness;
- unauthenticated GitHub REST validation ориентирован на public-readable repositories;
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
- [`docs/phase-7-smoke-test.md`](docs/phase-7-smoke-test.md)
- [`docs/adr/`](docs/adr/)
