# ChatGPT Orchestra — Roadmap: Browser Extension → Desktop Application

> **Статус документа:** основной архитектурный и продуктовый roadmap после `2.0.0-alpha.10`.
>
> **Текущий baseline:** Phases 0–9 завершены. Orchestra уже умеет planning, parallel scheduling, Git artifact validation, independent review, verified integration и deterministic Pause/Resume/Crash Recovery внутри Microsoft Edge extension.
>
> **Новая цель:** не переписывать продукт заново, а постепенно превратить существующую extension-реализацию в platform-neutral Orchestra Core и затем перенести основной runtime в отдельное desktop-приложение.

---

# 1. Новое видение продукта

ChatGPT Orchestra должна эволюционировать из браузерного расширения в локальную инженерную программу, которая:

1. хранит проект и orchestration state локально;
2. управляет несколькими ChatGPT executor sessions;
3. работает с локальным Git repository/worktrees;
4. запускает локальные verification commands;
5. переживает закрытие браузера, приложения и перезапуск компьютера;
6. показывает весь проект через единый desktop Dashboard;
7. использует extension только как временный/опциональный browser bridge;
8. в конечном состоянии может работать без extension.

Целевой пользовательский сценарий:

```text
Launch ChatGPT Orchestra Desktop
          ↓
Open local repository / clone GitHub repository
          ↓
Choose project goal
          ↓
Start Orchestra
          ↓
Planning → DAG → Parallel Workers → Review → Integration
          ↓
Local worktrees + local verification
          ↓
Pause / Resume / Recovery
          ↓
Verified integration branch
          ↓
User-controlled final merge / push / PR
```

Пользователь не должен воспринимать браузерные вкладки как сам продукт. ChatGPT sessions — только один из типов executor nodes.

---

# 2. Что уже построено и не должно быть переписано

Phases 0–9 остаются foundation нового desktop-продукта.

| Phase | Результат | Статус |
|---|---|---|
| 0 | Rename / repository hygiene | ✅ Complete |
| 1 | Deterministic ChatGPT DOM adapter | ✅ Complete |
| 2 | Service Worker + Tab Registry | ✅ Complete |
| 3 | Orchestra Protocol v1 + Event Bus | ✅ Complete |
| 4 | Project Bootstrap + Planning DAG | ✅ Complete |
| 5 | Conflict-aware Parallel Scheduler | ✅ Complete |
| 6 | Git Task Isolation / artifact provenance | ✅ Complete |
| 7 | Independent Review Loop | ✅ Complete |
| 8 | Integrator + Semantic Conflict remediation | ✅ Complete |
| 9 | Pause / Stop Now / Resume / Crash Recovery | ✅ Complete (`2.0.0-alpha.10`) |

Следующие части должны максимально переиспользоваться:

```text
Protocol
Planning pipeline
Task graph / DAG validation
Scheduler
Conflict policy
Task/run state machines
Git provenance rules
Review loop
Integration policy
Recovery control plane
Prompt contracts
Event identity / idempotency
```

Browser-specific части будут постепенно превращены в adapters:

```text
chrome.tabs
chrome.runtime messaging
chrome.storage.local
chrome.alarms
MV3 service-worker lifecycle
popup UI
ChatGPT content scripts / DOM bridge
```

---

# 3. Главная стратегия миграции

## 3.1. Никакого big-bang rewrite

Запрещённый путь:

```text
Extension
   ↓
остановить разработку
   ↓
переписать всё под Electron
   ↓
надеяться, что поведение осталось тем же
```

Правильный путь:

```text
Existing Extension
       ↓
Platform contracts вокруг существующего Core
       ↓
Extension adapters используют те же contracts
       ↓
Portable persistence + Orchestrator API
       ↓
Desktop shell запускает тот же Core
       ↓
Extension временно работает как Agent bridge
       ↓
Local Git/worktree runtime
       ↓
Direct desktop ChatGPT runtime
       ↓
Desktop becomes primary product
```

На каждом шаге предыдущий runtime должен оставаться рабочим до появления deterministic parity нового.

## 3.2. Core не знает о платформе

После portability phases внутри Core не должно быть прямых зависимостей от:

```text
chrome.*
Electron APIs
Playwright APIs
DOM
SQLite driver
Node child_process
filesystem paths конкретной OS
```

Core работает только через interfaces/contracts.

## 3.3. Extension становится reference adapter

Текущая extension не выбрасывается.

Она выполняет две роли:

1. reference implementation platform contracts;
2. временный companion bridge между desktop Core и обычными Edge/ChatGPT tabs.

Это позволяет перенести control plane на компьютер раньше, чем будет готов direct browser automation.

## 3.4. Desktop сначала control plane, потом executor runtime

Не нужно одновременно переносить Scheduler и переписывать ChatGPT automation.

Промежуточное состояние:

```text
Desktop App
  ├─ Orchestra Core
  ├─ SQLite state
  ├─ Dashboard
  └─ AgentRuntime: Extension Bridge
                         ↓
                 Edge extension
                         ↓
                    ChatGPT tabs
```

Позже:

```text
Desktop App
  ├─ Orchestra Core
  ├─ SQLite state
  ├─ Dashboard
  ├─ Local Git Runtime
  └─ AgentRuntime: Playwright/CDP
                         ↓
                 managed Chromium
                         ↓
                    ChatGPT sessions
```

---

# 4. Целевая архитектура

```text
                           ┌──────────────────────────┐
                           │       Desktop UI         │
                           │   Dashboard / Controls   │
                           └────────────┬─────────────┘
                                        │
                               Orchestrator API
                                        │
                           ┌────────────▼─────────────┐
                           │      Orchestra Core      │
                           │                          │
                           │ Planning / Scheduler     │
                           │ Review / Integration     │
                           │ Recovery / Protocol      │
                           │ State machines           │
                           └────────────┬─────────────┘
                                        │
                              Platform Contracts
              ┌─────────────────────────┼─────────────────────────┐
              │                         │                         │
      ┌───────▼────────┐        ┌───────▼────────┐       ┌────────▼───────┐
      │  AgentRuntime  │        │   StateStore   │       │  GitWorkspace │
      └───────┬────────┘        └───────┬────────┘       └────────┬───────┘
              │                         │                         │
       extension bridge           chrome.storage              GitHub REST
              or                       or                        or
       Playwright/CDP               SQLite                  local Git CLI
              │                         │                         │
              └─────────────────────────┴─────────────────────────┘
```

UI никогда не читает Store напрямую. Она работает через Orchestrator API.

---

# 5. Platform contracts

Контракты вводятся постепенно поверх существующего кода. Сначала допускаются wrappers вокруг текущих классов; не требуется одномоментное перемещение всех файлов.

## 5.1. AgentRuntime

Core должен видеть logical agents, а не Chrome tabs.

Минимальный contract:

```text
AgentRuntime
  listAgents()
  createAgent(role, options)
  destroyAgent(agentId)
  getAgentState(agentId)
  sendPrompt(agentId, prompt)
  stopGeneration(agentId)
  bindProtocolContext(agentId, context)
  clearProtocolContext(agentId)
  openAgent(agentId)
  subscribeAgentEvents(listener)
```

Реализации:

```text
ExtensionAgentRuntime
DesktopBridgeAgentRuntime
PlaywrightAgentRuntime
FakeAgentRuntime
```

`agentId` не должен означать `tabId`, `pageId` или browser process ID.

## 5.2. StateStore

```text
StateStore
  get(namespace, key)
  set(namespace, key, value)
  delete(namespace, key)
  transaction(fn)
  snapshot(projectId)
  migrate(fromVersion, toVersion)
```

Реализации:

```text
ChromeStorageStateStore
SQLiteStateStore
MemoryStateStore
```

Core state schema должен быть одинаковым независимо от backend.

## 5.3. TimerRuntime

Вместо прямых `chrome.alarms` / `setInterval`:

```text
TimerRuntime
  schedule(id, when/policy)
  cancel(id)
  now()
  subscribe(listener)
```

Реализации:

```text
ChromeAlarmRuntime
NodeTimerRuntime
FakeDeterministicTimerRuntime
```

## 5.4. GitWorkspace / GitProvider

Существующий `GitProvider` сохраняется для independent provenance checks.

Для desktop добавляется более сильный local contract:

```text
GitWorkspace
  openRepository(path/url)
  getBaseState()
  createTaskWorkspace(taskId, runId, startSha)
  getChangedFiles(workspaceId)
  getDiff(workspaceId)
  commit(workspaceId, message)
  createIntegrationWorkspace(runId)
  mergeTaskArtifact(...)
  push(...)
  cleanup(...)
```

Desktop-реализация использует локальный Git и worktrees.

## 5.5. CommandRunner

```text
CommandRunner
  run(command, args, cwd, policy)
  cancel(runId)
```

Обязательные свойства:

- timeout;
- bounded stdout/stderr;
- explicit cwd;
- sanitized environment;
- cancellation;
- audit record;
- repository trust policy.

## 5.6. Orchestrator API

Единственная точка между UI и Core.

Commands:

```text
createProject
startPlanning
startExecution
pause
stopNow
resume
retryTask
cancelTask
changePriority
reassignAgent
requestReview
startIntegration
```

Queries:

```text
getProject
getTaskGraph
getAgents
getEvents
getWarnings
getRecoveryState
getMetrics
```

Subscriptions:

```text
projectChanged
taskChanged
agentChanged
eventAdded
warningAdded
recoveryChanged
```

Popup, desktop renderer и будущие clients используют один contract.

---

# 6. Persistence strategy

## 6.1. Canonical domain state

Canonical state должен сериализоваться без Chrome/Electron objects.

Запрещено сохранять как source of truth:

```text
Tab objects
DOM nodes
Browser handles
Electron WebContents
Playwright Page references
process handles
```

Разрешены logical references:

```text
agentId
projectId
taskId
runId
reviewId
integrationRunId
workspaceId
branch
commit SHA
protocol context
```

## 6.2. Desktop SQLite

Desktop target persistence:

```text
SQLite (WAL mode)
  projects
  snapshots
  events
  runtime metadata
  migrations
```

Большие artifacts не обязательно хранить blob'ами в БД. Для них можно использовать application data directory + content hash/reference.

## 6.3. Portable Project Bundle

До перехода на desktop необходимо уметь экспортировать project state из extension.

Пример логической структуры:

```text
orchestra-project/
  manifest.json
  project.json
  state.json
  events.ndjson
  decisions.json
  artifacts/
```

Bundle должен:

- иметь schemaVersion;
- быть валидируемым до import;
- не содержать secrets;
- позволять extension → desktop import;
- поддерживать fail-closed migration.

## 6.4. Migration rule

Никакой автоматический scheduler dispatch до успешной migration/reconciliation.

```text
Load
  ↓
Validate schema
  ↓
Backup
  ↓
Migrate
  ↓
Reconcile artifacts/runtime
  ↓
Open dispatch gate
```

---

# 7. Desktop technology direction

## 7.1. Reference stack

Для первой desktop-реализации предпочтительный путь:

```text
Electron + Node.js
```

Причина — существующий Core написан на JavaScript, а будущий runtime требует browser automation, filesystem, SQLite, Git и subprocess management.

Важно: Electron — shell, а не часть Core.

Если позже появится причина перейти на Tauri/другой shell, Core/Orchestrator API не должны от этого меняться.

## 7.2. ChatGPT runtime

Конечный desktop runtime:

```text
Playwright / Chrome DevTools Protocol
+ dedicated persistent Chromium profile
```

Не извлекать cookies из обычного пользовательского браузерного профиля.

Пользователь один раз выполняет login в выделенном Orchestra browser profile.

## 7.3. Local Git

Предпочтительно использовать установленный системный Git.

Credentials:

- SSH agent;
- Git Credential Manager;
- system credential helper.

Orchestra не должна хранить GitHub password/token в project state/event log.

---

# 8. Версионный roadmap после alpha.10

## Phase 10 — Platform Boundary + Orchestrator API

**Статус:** NEXT.

**Цель:** сделать существующий extension Core переносимым, не меняя пользовательское поведение.

### Реализация

- [ ] составить inventory всех прямых `chrome.*` usages;
- [ ] разделить domain Core и extension composition root;
- [ ] ввести `AgentRuntime` contract;
- [ ] ввести `StateStore` contract;
- [ ] ввести `TimerRuntime` contract;
- [ ] формализовать `Orchestrator API` command/query DTO;
- [ ] обернуть текущий TabRegistry/targeted messaging в `ExtensionAgentRuntime`;
- [ ] обернуть `chrome.storage.local` в `ChromeStorageStateStore`;
- [ ] обернуть `chrome.alarms` в `ChromeAlarmRuntime`;
- [ ] перевести Planning/Scheduler/Review/Integration/Recovery на dependency injection contracts;
- [ ] service worker оставить composition root, а не domain owner;
- [ ] добавить `FakeAgentRuntime`, `MemoryStateStore`, deterministic timer для tests;
- [ ] запретить новым Core modules импортировать browser APIs напрямую.

### Инвариант

```text
core/** MUST NOT reference chrome.*
```

### DoD

1. Edge extension ведёт себя так же, как alpha.10.
2. Existing Phase 1–9 state machines работают через injected contracts.
3. Core tests запускаются без Chrome globals.
4. UI вызывает commands через Orchestrator API, а не напрямую через internal stores.

Это самый важный шаг всей desktop migration.

---

## Phase 11 — Portable Persistence + Project Export/Import

**Цель:** отвязать durable state от `chrome.storage.local` и подготовить migration bridge.

### Реализация

- [ ] определить canonical portable state schema;
- [ ] namespace existing stores через общий StateStore;
- [ ] `ChromeStorageStateStore` conformance suite;
- [ ] `MemoryStateStore` conformance suite;
- [ ] первая `SQLiteStateStore` реализация под Node;
- [ ] transactional write semantics;
- [ ] snapshot + append-only event persistence strategy;
- [ ] schema migration registry;
- [ ] automatic pre-migration backup;
- [ ] portable Project Bundle export;
- [ ] Project Bundle import/validation;
- [ ] redaction secrets из export;
- [ ] extension → SQLite migration test.

### DoD

Один и тот же persisted project можно:

```text
export from extension
→ validate
→ import into SQLiteStateStore
→ load identical logical project/task/review/integration/recovery state
```

Никакие browser IDs не являются обязательной частью переносимого snapshot.

---

## Phase 12 — Portable Dashboard + Observability API

**Цель:** построить Dashboard один раз и затем использовать его и в extension, и в desktop.

### Dashboard v1

Показывает:

```text
Project status / goal / repository / base
Recovery lifecycle
DAG and task states
Active runs
Reviews
Integration state
Agent health
Scheduler decisions
Recent events
Warnings / NEEDS_USER
Git artifacts
Local metrics
```

### Правило UI

Dashboard не имеет прямого доступа к:

```text
chrome.storage
chrome.tabs
SQLite
SchedulerStore
ReviewStore
IntegrationStore
```

Только:

```text
Orchestrator API
```

### Возможности

- [ ] task details;
- [ ] event timeline;
- [ ] agent health;
- [ ] scheduler explanation;
- [ ] pause/resume/stop;
- [ ] retry/cancel task;
- [ ] change priority;
- [ ] reassign agent;
- [ ] open corresponding executor;
- [ ] inspect review/integration evidence;
- [ ] filter warnings/errors;
- [ ] export project/debug bundle.

### DoD

Один Dashboard frontend может работать:

1. внутри extension host;
2. в standalone test host с Fake Orchestrator API.

Это будущий renderer desktop app.

---

## Phase 13 — Context Management + Portable Agent Packets

**Цель:** ChatGPT session должна быть заменяемым executor, а не носителем project memory.

### Реализация

- [ ] Lead summary artifact;
- [ ] task packet schema;
- [ ] review packet schema;
- [ ] integration packet schema;
- [ ] decisions register;
- [ ] context budget policy;
- [ ] completed-task compaction;
- [ ] artifact references вместо transcript copying;
- [ ] fresh Lead replacement;
- [ ] fresh Worker replacement;
- [ ] fresh Reviewer/Integrator bootstrap из persisted packets;
- [ ] prompt version provenance;
- [ ] bounded repository context selection.

### DoD

Полностью новый ChatGPT session может взять незавершённую logical role из persisted state + packets без доступа к полной истории старого чата.

Это обязательный prerequisite для надёжного desktop AgentRuntime.

---

## Phase 14 — Contract Tests + CI Foundation

**Цель:** второй runtime нельзя добавлять без автоматических parity tests.

### Unit / deterministic tests

- protocol;
- reducers/state machines;
- scheduler;
- review;
- integration;
- recovery;
- migrations;
- project export/import;
- context packets.

### Adapter conformance suites

Один набор tests применяется к:

```text
AgentRuntime
StateStore
TimerRuntime
GitWorkspace
Orchestrator API
```

### Browser fixtures

Mock ChatGPT HTML states:

```text
idle
generating
completed
composer occupied
error
login required
navigation changed
```

### CI

- [ ] GitHub Actions;
- [ ] unit tests;
- [ ] integration tests;
- [ ] manifest validation;
- [ ] migration tests;
- [ ] extension mock-browser tests;
- [ ] SQLite tests;
- [ ] package/version consistency.

### DoD

PR не может считаться green без автоматического Core + contract suite.

Production ChatGPT smoke-test остаётся отдельным manual/release gate.

---

## Phase 15 — Desktop Shell Bootstrap

**Цель:** запустить настоящий Orchestra Core как локальный desktop process, пока executor'ы ещё fake.

### Reference implementation

```text
apps/desktop/
  main/       Electron/Node process
  renderer/   shared Dashboard
```

### Реализация

- [ ] desktop application bootstrap;
- [ ] application data directory;
- [ ] SQLiteStateStore;
- [ ] NodeTimerRuntime;
- [ ] local structured logs;
- [ ] Orchestrator API IPC boundary;
- [ ] shared Dashboard renderer;
- [ ] FakeAgentRuntime;
- [ ] open/import Project Bundle;
- [ ] crash/restart desktop process recovery;
- [ ] dev packaging for primary OS;
- [ ] no Electron/Node objects leaked into Core DTOs.

### DoD

Desktop app может выполнить synthetic end-to-end project через FakeAgentRuntime:

```text
planning fixture
→ DAG
→ parallel fake workers
→ review
→ integration
→ pause app
→ kill app
→ reopen
→ deterministic resume
```

Extension при этом продолжает работать независимо.

---

## Phase 16 — Desktop Control Plane + Extension Companion Bridge

**Цель:** перенести реальный source of truth из MV3 service worker в desktop, не переписывая ChatGPT DOM automation.

### Архитектура переходного периода

```text
Desktop
  Orchestra Core
  SQLite
  Dashboard
      │
      │ AgentRuntime transport
      ▼
Edge Extension (thin companion)
      │
      ▼
ChatGPT tabs/content adapter
```

### Реализация

- [ ] companion transport contract;
- [ ] secure pairing desktop ↔ extension;
- [ ] production transport: Native Messaging или equivalent authenticated local channel;
- [ ] dev-only loopback transport при необходимости;
- [ ] extension service worker перестаёт быть canonical project state owner в companion mode;
- [ ] extension передаёт только agent/browser events;
- [ ] desktop выдаёт prompts/stop/context commands;
- [ ] protocol events persist'ятся desktop EventStore;
- [ ] extension popup в companion mode показывает connection status + `Open Orchestra`;
- [ ] migration wizard Chrome storage → SQLite;
- [ ] disconnect/reconnect bridge recovery;
- [ ] version handshake extension ↔ desktop.

### Security

Local bridge обязан иметь authentication/pairing; нельзя открывать unauthenticated localhost control endpoint.

### DoD

Реальный ChatGPT multi-agent project проходит Phases 4–9, но canonical Core/state уже живут в desktop process. Extension используется только как browser/DOM adapter.

Это главный migration checkpoint: Orchestra уже desktop-приложение по control plane, даже если executor browser bridge ещё extension-based.

---

## Phase 17 — Local Repository Runtime + Git Worktrees

**Цель:** перенести инженерную работу с remote-only Git artifact validation на полноценные локальные isolated workspaces.

### Repository modes

Desktop поддерживает:

```text
Open existing local repository
Clone repository from URL
```

### Task isolation

Каждый mutating run получает local worktree:

```text
<OrchestraData>/workspaces/<projectId>/<taskId>/<runId>/
```

и branch:

```text
orchestra/<projectId>/<taskId>/<runId>
```

### Реализация

- [ ] local repository registry;
- [ ] Git CLI adapter;
- [ ] worktree create/remove;
- [ ] per-run workspace metadata;
- [ ] diff/scope validation локально;
- [ ] local commit validation;
- [ ] integration worktree;
- [ ] deterministic `--no-ff` merges;
- [ ] local verification commands;
- [ ] optional push only after local validation;
- [ ] system Git credentials / SSH integration;
- [ ] abandoned worktree cleanup policy;
- [ ] workspace recovery after app crash;
- [ ] changed-files provenance independent from agent report.

### Command execution trust model

Repository получает trust state:

```text
UNTRUSTED
TRUSTED
```

До выполнения repository-defined commands пользователь должен явно разрешить local execution.

CommandRunner должен:

- работать только внутри approved workspace cwd;
- использовать args, а не unsafe shell interpolation по умолчанию;
- ограничивать runtime/output;
- поддерживать cancel;
- redaction известных secret patterns;
- писать audit metadata без secret values.

### DoD

Worker task может быть полностью проверена локально:

```text
worktree
→ changes
→ scope check
→ tests
→ commit
→ independent review
```

без обязательного push каждой промежуточной ветки на GitHub.

---

## Phase 18 — Direct Desktop ChatGPT AgentRuntime

**Цель:** убрать обязательную зависимость desktop Orchestra от browser extension.

### Runtime

Предпочтительно:

```text
Playwright / CDP
+ dedicated persistent Chromium profile
```

### Реализация

- [ ] desktop-managed Chromium lifecycle;
- [ ] dedicated Orchestra browser profile;
- [ ] explicit login onboarding;
- [ ] logical agent ↔ browser page mapping;
- [ ] reuse существующего ChatGPTAdapter logic где возможно;
- [ ] generation detection;
- [ ] prompt send;
- [ ] Stop Generation;
- [ ] protocol artifact extraction;
- [ ] heartbeat/health;
- [ ] chat navigation detection;
- [ ] fresh page replacement;
- [ ] browser process crash recovery;
- [ ] visible/open-chat action из Dashboard;
- [ ] rate/concurrency policy;
- [ ] compatibility contract tests против ExtensionAgentRuntime.

### Не делать

- не читать cookies из обычного Edge/Chrome профиля;
- не хранить ChatGPT credentials в Orchestra state;
- не связывать `agentId` навечно с конкретной Page;
- не считать browser process source of truth.

### DoD

Полный reference project выполняется из desktop app без установленного extension.

В этот момент extension становится optional companion/fallback runtime.

---

## Phase 19 — Desktop Parity + Reliability / Security Hardening

**Цель:** доказать, что desktop runtime как минимум не слабее extension baseline.

### Parity matrix

Для ExtensionAgentRuntime и PlaywrightAgentRuntime прогоняются одинаковые сценарии:

1. Planning happy path.
2. Parallel 3–4 Workers.
3. Dependency unlock.
4. Review rework.
5. Text conflict.
6. Semantic conflict.
7. Worker/session death.
8. Duplicate event.
9. Pause safe point.
10. Stop Now.
11. App/browser restart.
12. Recovered Git progress.
13. SQLite migration/recovery.
14. Local worktree recovery.

### Reliability budgets

- max task retries;
- max review loops;
- max integration repairs;
- max protocol errors;
- max browser restarts;
- max command runtime;
- max parallel agents;
- max event/log retention.

### Security hardening

- [ ] repository trust boundary;
- [ ] local command execution audit;
- [ ] secret redaction;
- [ ] no secrets in Project Bundle;
- [ ] signed desktop builds;
- [ ] secure update strategy;
- [ ] desktop IPC allowlist;
- [ ] renderer isolation / CSP;
- [ ] authenticated companion bridge;
- [ ] file path validation;
- [ ] destructive Git actions require policy/user gate;
- [ ] telemetry remains opt-in.

### DoD

Chaos tests не приводят к destructive action в unknown state, а desktop parity suite проходит release threshold.

---

## Phase 20 — Desktop-first Alpha Release

**Цель:** переключить основной продуктовый путь с extension на desktop, не удаляя fallback преждевременно.

### Desktop alpha scope

- один active project;
- local repo или clone by URL;
- 1 Lead + до 4 Worker slots;
- Planning/Critic/DAG;
- conflict-aware scheduler;
- local worktrees;
- independent review;
- verified integration worktree/branch;
- Pause/Resume/Stop;
- process/browser restart recovery;
- portable Dashboard;
- Project Bundle import/export;
- manual final target merge/push by default.

### Distribution

Первый release target можно ограничить одной primary OS, но Core/platform contracts обязаны оставаться cross-platform.

### Extension policy

На alpha extension остаётся:

```text
Optional Companion Runtime
```

а не удаляется.

Она нужна как:

- fallback при ChatGPT DOM/runtime regression в direct desktop browser;
- migration bridge для старых projects;
- diagnostic comparison implementation.

### Release gate

Desktop-first alpha нельзя выпускать без успешных сценариев:

1. fresh install + ChatGPT login onboarding;
2. open local repository;
3. clone repository;
4. 4-task parallel happy path;
5. dependency path;
6. review rework;
7. text conflict;
8. semantic conflict;
9. task/browser death;
10. app process kill/restart;
11. OS restart / project resume;
12. Pause/Resume;
13. Stop Now + late event protection;
14. local worktree salvage;
15. export/import project;
16. extension-companion fallback;
17. no duplicate irreversible side effects.

---

## Phase 21 — Post-alpha Cutover / Provider Expansion

**Цель:** только после desktop alpha решить, что делать с extension как самостоятельным продуктом.

Возможные решения:

### Option A — Extension remains companion only

Основной сценарий desktop-first, extension — thin bridge.

### Option B — Keep both runtimes

Extension и desktop являются двумя officially supported AgentRuntime implementations.

### Option C — Deprecate standalone extension orchestration

Extension сохраняет только browser integration, если direct desktop runtime доказал большую надёжность.

Только после этого имеет смысл добавлять:

- другие AI providers;
- другие browser runtimes;
- remote workers;
- optional local models;
- multi-project concurrency;
- remote orchestration server.

До desktop parity это не приоритет.

---

# 9. Миграционные milestones

## Milestone A — Portable Core

Phases 10–11.

Результат:

> Core больше не привязан к Chrome APIs, state можно перенести из extension storage в SQLite.

## Milestone B — Portable Product Surface

Phases 12–14.

Результат:

> Dashboard, context packets и tests существуют независимо от browser host.

## Milestone C — Desktop Control Plane

Phases 15–16.

Результат:

> Desktop process является source of truth, extension — только Agent bridge.

## Milestone D — Local Engineering Runtime

Phase 17.

Результат:

> Task isolation/testing/integration происходят в локальных worktrees под контролем desktop app.

## Milestone E — Extensionless Runtime

Phase 18.

Результат:

> Desktop управляет ChatGPT sessions напрямую.

## Milestone F — Desktop Alpha

Phases 19–20.

Результат:

> Desktop становится основным способом использования Orchestra.

---

# 10. Repository layout: постепенная цель

Не нужно одним PR физически переносить весь repository.

Целевой layout:

```text
apps/
  extension/
  desktop/

packages/
  core/
    planning/
    scheduler/
    review/
    integration/
    recovery/
  protocol/
  prompts/
  contracts/
    agent-runtime/
    state-store/
    timer-runtime/
    git-workspace/
    orchestrator-api/
  adapters/
    extension/
    desktop/
    fake/
  ui/

content/
  chatgpt-adapter/

tests/
  unit/
  contracts/
  integration/
  browser-fixtures/
  desktop/
```

Переезд файлов должен происходить только когда boundary уже покрыт tests. Cosmetic folder move сам по себе не является целью.

---

# 11. Обновлённые архитектурные инварианты

Эти правила должны быть закреплены tests и code review:

1. Core не импортирует `chrome.*`, Electron, Playwright или DOM.
2. UI не читает persistence backend напрямую.
3. Extension и desktop используют один Orchestrator API.
4. `agentId` не равен platform tab/page identifier.
5. Browser/process objects никогда не являются durable state.
6. Duplicate `eventId` не производит второй side effect.
7. Stale `runId` не может завершить fresh attempt.
8. Worker `DONE` не означает approval.
9. Approval не означает integration.
10. Integration verification не означает final target merge без соответствующей policy.
11. Pause/Stop/Recovery имеют приоритет над scheduling.
12. Crash recovery всегда выполняет reconciliation до dispatch.
13. Failed state migration закрывает dispatch gate.
14. Lost executor session не удаляет task/run history.
15. Fresh executor получает fresh platform/session identity.
16. Recovered Git progress принимается только после independent validation.
17. Local command runner работает только в trusted repository/workspace policy.
18. Secrets не записываются в event log/project export.
19. Desktop renderer не получает unrestricted Node capabilities.
20. Extension companion transport authenticated.
21. Target branch destructive actions не выполняются в ambiguous state.
22. Один project snapshot можно загрузить независимо от runtime, который его создал.

---

# 12. Human-in-the-loop levels

Уровни autonomy остаются platform-neutral.

## Level 0 — Observe

Планирование и предложения без execution.

## Level 1 — Execute, manual integration/final merge

Workers и review автоматизированы, integration/final actions подтверждаются.

## Level 2 — Auto integration, manual target promotion

Рекомендуемый desktop alpha default.

## Level 3 — Full allowed automation

Только после hardening; destructive target operations выполняются автоматически только при всех configured gates green.

---

# 13. Local metrics / observability

Полезные локальные метрики:

- project completion rate;
- tasks completed;
- attempts per task;
- review rejection rate;
- integration repair rate;
- text/semantic conflict rate;
- worker utilization;
- blocked time;
- human interventions;
- duplicate events prevented;
- recovery success rate;
- browser/runtime restarts;
- task scope violations;
- local test pass rate;
- worktree reuse/salvage rate;
- wall-clock speedup vs sequential estimate.

External telemetry — только отдельное opt-in решение.

---

# 14. Что сознательно не делать во время миграции

Пока desktop parity не достигнут, не приоритетны:

- собственный LLM backend;
- remote distributed scheduler;
- multi-machine agent pool;
- много проектов одновременно;
- IDE replacement;
- support десятков providers;
- automatic secret management собственного формата;
- cloud sync project state;
- unattended auto-merge в production branches;
- попытка заменить Git собственным VCS layer.

Главный риск — не недостаток features, а одновременная смена слишком многих platform assumptions.

---

# 15. Reference end-to-end scenario после миграции

Reference project должен постоянно использоваться для parity tests.

Пример:

> Добавить OAuth login в существующий web-проект: backend callback, frontend UI, tests и docs.

```text
T1 Repository discovery / auth constraints
           ↓
T2 OAuth API/config contract
        ↙          ↘
T3 Backend       T4 Frontend
     ↓               ↓
T5 Backend tests  T6 Frontend tests
        ↘          ↙
        T7 Integration verification
                  ↓
              T8 Documentation
```

Desktop доказательство результата:

```text
user goal
→ portable project state
→ approved DAG
→ local task worktrees
→ commits
→ independent reviews
→ integration worktree
→ local verification evidence
→ persisted final report
```

После убийства desktop process и browser process эта цепочка должна восстанавливаться из SQLite + Git + project artifacts.

---

# 16. Критерий успешной desktop migration

Миграцию можно считать состоявшейся, когда пользователь может:

1. установить desktop app;
2. войти в ChatGPT через dedicated Orchestra browser profile;
3. открыть local repository;
4. дать цель;
5. запустить несколько параллельных executor sessions;
6. наблюдать всё через desktop Dashboard;
7. не использовать extension в normal path;
8. получить task worktrees/commits/reviews/integration;
9. закрыть приложение и браузер;
10. после перезапуска компьютера восстановить проект;
11. получить тот же logical state независимо от platform handles;
12. вручную подтвердить final target promotion;
13. при необходимости переключиться на Extension Companion без потери project state.

Главная ценность Orchestra остаётся прежней:

> **устойчивое параллельное выполнение инженерной работы через независимых AI-исполнителей с централизованным состоянием, контролем зависимостей, проверкой результата и безопасным восстановлением.**

Desktop migration не меняет эту модель — она убирает ограничения браузерного extension runtime вокруг уже работающего Core.

---

# 17. Ближайшая следующая задача

Следующая implementation-задача после `2.0.0-alpha.10`:

> **Phase 10 — Platform Boundary + Orchestrator API.**

Нельзя сразу начинать Electron UI или Playwright automation.

Сначала необходимо доказать, что существующие Planning/Scheduler/Review/Integration/Recovery могут работать без знания о `chrome.*`.

Первый Phase 10 PR должен сделать behavior-preserving vertical slice:

```text
Current chrome.tabs messaging
        ↓
ExtensionAgentRuntime
        ↓
AgentRuntime contract
        ↓
Scheduler / Review / Integration
```

и аналогично для persistence:

```text
chrome.storage.local
        ↓
ChromeStorageStateStore
        ↓
StateStore contract
        ↓
Core stores
```

Только после того как существующая extension проходит прежние regression/smoke gates через эти boundaries, начинается Phase 11.
