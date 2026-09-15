# Changelog

Все заметные изменения ChatGPT Orchestra фиксируются в этом файле.

Формат основан на принципах Keep a Changelog. Новая multi-agent архитектура развивается как линия `2.x`; prerelease-имя хранится в `manifest.version_name`.

## [2.0.0-alpha.20] - 2026-09-15

Эта запись консолидирует desktop migration после alpha.15 (Phases 15–20) и фиксирует состояние release candidate перед реальными manual release gates.

### Added

- Electron/Node desktop shell с shared Dashboard, application data directory, SQLite persistence и IPC boundary;
- desktop control plane с authenticated Extension Companion / Native Messaging bridge и migration из extension state;
- local repository runtime: open/clone repository, isolated task/integration Git worktrees, local provenance/scope validation и deterministic `--no-ff` integration;
- repository trust boundary и bounded local verification command runner с cancellation/audit/redaction;
- direct desktop ChatGPT `AgentRuntime` с dedicated managed-browser profile, interactive login onboarding, logical agent/page mapping и browser recovery;
- parity/reliability/security suites для desktop runtime, recovery, worktrees, companion bridge, command execution и duplicate/late-event guards;
- desktop-first alpha onboarding для local repository/clone flow и single active project policy;
- automated evidence mapping для всех 17 Phase 20 alpha scenarios;
- exact build identity (`version + 40-char source commit`) в packaged Windows candidate и runtime/debug evidence;
- Windows NSIS candidate packaging, staged fallback extension и candidate artifact verification in CI;
- manual evidence preflight для A01 clean-install/login и A11 real-OS-reboot/recovery scenarios;
- strict signed `Alpha Release Validation` workflow с commit-bound A01/A11 GitHub issue-comment evidence;
- release asset manifest, SHA-256 checksums, signed bundle verification и fail-closed draft/prerelease publication;
- explicit manual, signed-only alpha update policy; automatic updater intentionally deferred post-alpha.

### Reliability and safety

- desktop state является canonical source of truth; browser pages/process handles не являются durable project state;
- dispatch остаётся закрытым до migration/startup/recovery reconciliation;
- local commands запускаются только в explicitly trusted repository/workspace, через executable + argv (`shell:false`) с bounded runtime/output;
- dirty abandoned worktrees salvage'ятся вместо destructive auto-cleanup;
- managed-browser runtime использует dedicated profile и не извлекает cookies/credentials из обычного Edge/Chrome profile;
- extension остаётся optional authenticated companion/fallback, а не primary orchestration runtime;
- Stop Now отменяет active local verification и блокирует late state-machine effects;
- Project Bundle/debug export redacts credentials и runtime identities;
- final target-branch merge/push остаётся user-controlled по default alpha policy;
- unsigned CI artifacts считаются только candidates; финальный Windows prerelease обязан иметь `Authenticode=Valid`;
- final release workflow принимает A01/A11 evidence только от того же exact source commit, который собирается и подписывается;
- alpha publication fail-closed: mismatch version/commit/evidence/signature/checksum/asset set блокирует или откатывает staged release/tag.

### Changed

- prerelease version обновлена до `2.0.0-alpha.20`;
- desktop managed-browser runtime становится primary alpha product path;
- extension policy изменена на `Optional Companion Runtime`;
- Windows 10/11 выбран primary alpha distribution target при сохранении platform-neutral Core/contracts;
- Phase 21 provider/cutover expansion заблокирован до завершения Phase 20 manual validation и signed alpha release.

### Validation

- current `main` Phase 15–20 CI matrix проходит Core/contracts, desktop shell, companion bridge, local Git/worktrees, direct browser runtime, parity/chaos, Phase 20 acceptance, release contract и Windows candidate packaging gates;
- `npm run test:alpha` является automated candidate gate;
- все 17 roadmap alpha scenarios имеют automated evidence;
- A01 и A11 намеренно требуют дополнительного реального human evidence, потому что CI не может правдиво доказать interactive login на clean Windows profile и настоящий OS reboot;
- финальный `v2.0.0-alpha.20` prerelease ещё не считается выпущенным до A01/A11 PASS на одном exact build commit и успешного signed `Alpha Release Validation` workflow.

### Release next

- merge финальный pre-release cleanup и дождаться green push CI;
- freeze один exact `main` commit;
- выполнить A01 и A11 на packaged candidate этого commit;
- настроить Windows signing credentials;
- запустить strict `Alpha Release Validation` и публиковать `v2.0.0-alpha.20` только после `Authenticode=Valid` и полной release-bundle verification.

---

## [2.0.0-alpha.15] - 2026-09-13

### Added

- GitHub Actions CI для pull requests и pushes в `main`;
- full Core test matrix на Node 18 и Node 22;
- reusable contract/conformance suites для `AgentRuntime`, `StateStore`, transactional state, `TimerRuntime`, `GitWorkspace` и Orchestrator API;
- `FakeGitWorkspace` как reference implementation будущего local Git/worktree contract;
- deterministic ChatGPT browser fixture corpus для idle/generating/completed/composer-occupied/error/login/navigation states;
- manifest/package/version/permission release validator;
- aggregate `npm run test:phase14` release gate;
- Phase 14 architecture doc и ADR 0014.

### Reliability and safety

- PR больше не считается green без автоматических Core + contract + persistence + browser fixture + release checks;
- CI использует read-only repository permissions и не получает write credentials для runtime tests;
- contract manifest синхронизирован с Orchestrator API v4, включая `contextSummary` и `contextPacket`;
- `GitWorkspace` contract добавлен до появления реального desktop Git runtime, чтобы Phase 15–17 implementations сразу проходили общий parity suite;
- первый CI rollout обнаружил реальный GenerationDetector regression: explicit busy внутри hydration grace мог не завершить busy → idle settling; detector исправлен так, что explicit generation signal отключает hydration grace для текущей generation;
- Phase 13 optional-first packet compaction и portable repair prompt expectations синхронизированы с regression suite без ослабления fail-closed packet gates;
- extension permissions и target-branch policy не изменились.

### Changed

- prerelease version обновлена до `2.0.0-alpha.15`;
- Platform Contracts обновлены до v4;
- Phase 15 — Desktop Shell Bootstrap — становится следующим roadmap этапом.

### Validation

- PR #25 final Actions run #5 на exact head прошёл полностью: Core Node 18/22, Contracts Node 18/22, SQLite/persistence Node 22, browser fixtures Node 18, release contract Node 18 и aggregate Phase 14 Node 22 — success;
- после squash merge push-to-`main` Actions run #6 повторил те же восемь green jobs;
- PR перед merge был `behind=0` и `mergeable=true`;
- production ChatGPT DOM остаётся отдельным manual smoke gate, как и предусмотрено roadmap.

### Next

- Phase 15 — Desktop Shell Bootstrap.

---

## [2.0.0-alpha.14] - 2026-09-13

### Added

- persisted `ContextStore` для compact Lead summary, bounded decisions register и packet audit metadata;
- `ContextPacketService` с versioned Lead, Task, Review, Integration и Repair packets;
- role-specific context budgets и prompt/packet provenance;
- fresh-session Lead replacement с сохранением существующего planning stage/run identity;
- Orchestrator API v4 queries `contextSummary` и `contextPacket`;
- Portable State v1 additive `context` namespace с backward compatibility для alpha.13 bundles;
- Phase 13 architecture doc, smoke test и ADR 0013;
- dedicated `npm run test:phase13` suite, включая fail-closed prompt gates и Lead replacement/registration regressions.

### Portability and safety

- chats остаются executors, а persisted Orchestra state + Context Packets являются source of truth для bootstrap роли;
- packets удаляют browser/runtime identifiers и transcript/history/raw-response fields;
- completed tasks и repository context передаются как bounded summaries/artifact refs вместо replay старого чата;
- work-critical planning/task/review/integration/repair source сохраняется дословно после runtime/transcript sanitization;
- optional Lead summary, decisions, completed-task summaries и repository context compact'ятся раньше critical payload;
- если critical payload не помещается в budget либо был structural/string-truncated, роль fail closed в `NEEDS_USER` с `reason=context_packet_incomplete`;
- Reviewer не может approve по неполному evidence packet, Integrator не может merge partial manifest;
- fresh Lead replay выполняется только при отсутствующем/mismatched planning protocol context;
- failed Lead bootstrap очищает protocol binding, чтобы последующая регистрация могла безопасно повторить delivery;
- extension permissions, Git validation, review separation и integration target policy не ослаблялись.

### Changed

- prerelease version обновлена до `2.0.0-alpha.14`;
- Worker prompt contract обновлён до v4, Planning/Reviewer/Integrator contracts — до v2;
- Orchestrator API обновлён до v4;
- Phase 14 — Contract Tests + CI Foundation — становится следующим roadmap этапом.

### Validation

- frozen PR review выполнен для packet compaction, critical-source completeness, Lead replacement delivery, API boundary, portable persistence и service-worker composition;
- feature branch перед merge была `behind=0`, PR #23 был `mergeable=true` и merged через exact-head squash;
- repository пока не имеет CI — это Phase 14;
- полный repository `npm test` / `npm run test:phase13` из checkout в текущей environment не запускался из-за отсутствующего DNS-доступа к GitHub;
- documented Edge fresh-session/replacement smoke-test остаётся внешний release gate.

### Next

- Phase 14 — Contract Tests + CI Foundation.

---

## [2.0.0-alpha.13] - 2026-09-13

### Added

- portable `ObservabilityService` и versioned Observability DTO v1;
- `OrchestratorApi` v3 с generic query/execute transport для extension и будущего desktop renderer;
- shared `DashboardApp`, работающий поверх injected transport;
- `ExtensionDashboardTransport` и standalone Fake transport host без Chrome runtime;
- Dashboard views для project/DAG/tasks, runs, Git artifacts, reviews, integration evidence, recovery, agent health, scheduler decisions, events, warnings и metrics;
- `TaskControlService` для safe Retry/Cancel/Priority/Reassign/Review/Integration/Open Executor actions;
- portable debug bundle export;
- Phase 12 architecture doc, smoke test и ADR 0012;
- `npm run test:phase12`.

### Portability and safety

- Dashboard не имеет прямого доступа к `chrome.storage`, `chrome.tabs`, SQLite или внутренним Scheduler/Review/Integration stores;
- observability/debug DTO рекурсивно удаляет `tabId`, `legacyTabId`, `sessionId`, `runtimeSource` и runtime sender bindings, включая EventBus provenance;
- privileged Orchestrator API commands по-прежнему отклоняются от agent/browser sessions;
- manual task mutations fail closed для active/unsafe states;
- cancel downstream-задач требует explicit cascade;
- Retry/Reassign, разрешающие `NEEDS_USER`, reopen scheduler/project только через Core service;
- cancellation всех tasks завершает scheduler/project как `CANCELLED`, а не `READY_FOR_INTEGRATION`;
- один и тот же Dashboard frontend работает в extension host и standalone Fake host;
- extension permissions не расширялись.

### Changed

- prerelease version обновлена до `2.0.0-alpha.13`;
- Orchestrator API обновлён до v3;
- popup теперь host'ит shared portable Dashboard, сохраняя bootstrap и legacy controls;
- Phase 13 становится следующим roadmap этапом.

### Validation

- frozen PR review выполнен для Observability read model, API privilege boundary, task controls, service-worker composition и Dashboard transport;
- feature branch перед merge была `behind=0`;
- dedicated `test:phase12` suite добавлена;
- полный repository `npm test` / `npm run test:phase12` из checkout в текущей environment не запускался из-за отсутствующего DNS-доступа к GitHub;
- Edge + standalone Dashboard smoke-test остаётся release gate.

### Next

- Phase 13 — Context Management + Portable Agent Packets.

---

## [2.0.0-alpha.12] - 2026-09-13

### Added

- canonical Portable State schema v1 для project-scoped logical state;
- `MigrationRegistry` с deterministic sequential migration path;
- pre-import backups с bounded history;
- Project Bundle v1 с schema/version/identity/size/checksum validation;
- popup Export Bundle / Import Bundle controls;
- `OrchestratorApi` v2 persistence query и bundle commands;
- `TransactionalStateStore` wrapper для serialized extension writes/import boundary;
- Node `SQLiteStateStore` на `node:sqlite` с WAL и `BEGIN IMMEDIATE` transactions;
- StateStore conformance tests для Chrome/Memory/SQLite;
- extension-shaped state → SQLite round-trip regression;
- Phase 11 architecture doc, smoke test и ADR 0011;
- `npm run test:phase11`.

### Portability and safety

- `tabId`, `legacyTabId`, `sessionId` и runtime sender bindings рекурсивно исключаются из portable snapshots;
- agent registry не переносит browser sessions и восстанавливается пустым;
- secrets/tokens/API keys/cookies/credentials/private-key material redacted перед export;
- project bundle содержит только exact project-scoped EventBus events/rejections;
- import разрешён только в `IDLE`, `PAUSED`, `STOPPED` или `RECOVERY_REQUIRED`;
- импортированное состояние всегда переводится в `RECOVERY_REQUIRED` до host-specific reconciliation;
- extension import требует reload и freeze'ит StateStore, чтобы stale in-memory writes не перезаписали новый state;
- namespace `projectId` mismatch отклоняется до persistence;
- SQLite external writes сериализуются за active transaction и не могут случайно присоединиться к ней;
- failed SQLite transactions rollback целиком;
- extension permissions и target-branch policy не изменились.

### Changed

- prerelease version обновлена до `2.0.0-alpha.12`;
- Orchestrator API обновлён до v2;
- extension composition root использует transactional StateStore wrapper;
- Project Bundle становится официальным migration bridge extension → future desktop host;
- current production runtime остаётся Edge extension.

### Validation

- focused native SQLite commit/rollback tests passed on Node 22;
- portable snapshot/bundle Memory → SQLite round-trip focused gate passed;
- post-import stale-write freeze focused gate passed;
- final targeted SQLite concurrency smoke passed;
- полный repository `npm test` / `npm run test:phase11` из checkout в текущей environment не запускался из-за отсутствующего DNS-доступа к GitHub;
- Edge import/export smoke-test остаётся release gate.

### Next

- Phase 12 — Portable Dashboard + Observability API;
- shared Dashboard frontend поверх Orchestrator API;
- no direct UI access to Chrome storage/tabs or SQLite.

---

## [2.0.0-alpha.11] - 2026-09-13

### Added

- platform contract v1 для `AgentRuntime`, `StateStore` и `TimerRuntime`;
- `ExtensionAgentRuntime` как адаптер существующего TabRegistry/Chrome tabs/message transport;
- `ChromeStorageStateStore` поверх `chrome.storage.local`;
- `ChromeAlarmRuntime` поверх MV3 alarms;
- deterministic `FakeAgentRuntime`, `MemoryStateStore` и `DeterministicTimerRuntime` для browser-free tests;
- platform-neutral `OrchestratorApi` v1 с command/query surface для popup и будущего desktop IPC;
- normalized runtime sender identity `kind/sessionId/agentId` для EventBus;
- generic runtime provenance в accepted/rejected Event Store records;
- source-level browser-boundary regression test;
- browser-free portable Orchestrator regression;
- Phase 10 architecture document, smoke test и ADR 0010;
- `npm run test:phase10`.

### Changed

- prerelease version обновлена до `2.0.0-alpha.11`;
- `ServiceWorkerOrchestrator` больше не вызывает `chrome.tabs` напрямую и работает через `AgentRuntime`;
- service worker стал явным extension composition root: собирает Chrome adapters и Core engines через dependency injection;
- popup/admin runtime messages теперь являются compatibility transport поверх `OrchestratorApi`;
- EventBus больше не использует `sender.tab.id` как canonical protocol identity;
- watchdog scheduling проходит через `TimerRuntime`;
- TabRegistry и EventStore принимают injected StateStore-compatible backend;
- extension permissions и Git/review/integration/recovery policies не изменились.

### Migration boundary

- persisted `tabId` остаётся compatibility metadata текущей extension schema; удаление platform IDs из canonical portable snapshot относится к Phase 11;
- SQLite, Project Bundle export/import, Electron и Playwright/CDP намеренно не входят в alpha.11;
- extension остаётся production/reference runtime и не переводится в companion-only mode на этой фазе.

### Validation

- focused reconstructed Node gate для новых contracts/FakeRuntime/OrchestratorApi/portable Orchestrator: 11/11 passed;
- полный repository `npm test` / `npm run test:phase10` в текущей execution environment не запускался из checkout из-за отсутствующего DNS-доступа к GitHub;
- production Edge smoke-test остаётся release gate.

### Next

- Phase 11 — Portable Persistence + Project Export/Import;
- portable state schema/migration registry;
- `SQLiteStateStore`;
- extension → desktop project bundle migration.

---

## [2.0.0-alpha.10] - 2026-09-13

### Added

- persisted `RecoveryStore` как отдельный lifecycle control plane поверх planning/scheduler/review/integration state;
- recovery states `IDLE`, `RUNNING`, `PAUSING`, `PAUSED`, `STOPPING`, `STOPPED`, `RECOVERING`, `RECOVERY_REQUIRED`;
- project-level **Pause**, **Resume** и **Stop Now** controls в popup;
- safe-point Pause: новые prompts блокируются сразу, а уже идущие generations могут закончиться и сохранить events/artifacts;
- Stop Now best-effort `STOP_GENERATION` для active role agents;
- `INTERRUPTED` Worker run semantics без ложного task completion;
- reconcile-before-resume pipeline для tabs, Worker runs, Git branches, Reviews, Integration и protocol contexts;
- crash snapshots с project/scheduler/review/integration/agent summaries и safe-point state;
- automatic MV3 service-worker recovery при сохранённой tab continuity;
- explicit `RECOVERY_REQUIRED` при browser-level continuity loss;
- independent reconciliation безопасного partial Git progress с reuse только через fresh run identity;
- fresh Worker identities для replacement tabs после browser loss;
- Phase 9 architecture doc, smoke test, ADR 0008 и recovery regression tests;
- `npm run test:phase9`.

### Reliability and safety

- dispatch fail-closed до завершения startup reconciliation (`bootReady` gate);
- во время `PAUSING`, `PAUSED`, `STOPPING`, `STOPPED`, `RECOVERING` и `RECOVERY_REQUIRED` новые Planner/Worker/Reviewer/Integrator prompts не запускаются;
- late `DONE`, `REVIEW_*`, `CONFLICT` и blocker events через Stop Now boundary могут остаться в Event Bus audit, но не применяются к state machines;
- missing Worker registry identity не переиспользуется как доказательство продолжения старого ChatGPT run;
- recovered task branch проверяется по immutable base, behind state, provider truncation и task scope до reuse commit;
- out-of-scope или неоднозначный recovered Git state переводит recovery в `RECOVERY_REQUIRED`;
- missing Reviewer получает fresh review identity, missing Integrator — fresh integration run identity;
- stale protocol contexts перестраиваются из persisted active identities до открытия dispatch;
- Phase 8 target policy `integration_branch_only` не меняется.

### Changed

- prerelease version обновлена до `2.0.0-alpha.10`;
- service-worker boot теперь проходит recovery preparation до инициализации runtime engines и завершает reconciliation перед новым dispatch;
- public project state может отображать lifecycle status отдельно от underlying work status;
- popup показывает recovery state, safe-point progress и recovery issues;
- browser restart больше не трактуется как обычный Worker retry без Git/tab reconciliation.

### Known limitations

- после полного browser loss Planning Lead требует явного reconnect/register пользователем;
- recovery не восстанавливает скрытый model context закрытого ChatGPT tab и вместо этого создаёт fresh run identity поверх independently verified persisted/Git state;
- initial GitHub REST reconciliation остаётся unauthenticated и ориентирована на public-readable repositories;
- browser E2E against production ChatGPT DOM остаётся ручным smoke-test.

### Not yet implemented

- platform-neutral portable persistence / SQLite;
- context compaction / context budget management;
- desktop shell / companion bridge;
- automatic target-branch promotion policy.

---

## [2.0.0-alpha.9] - 2026-09-13

### Added

- persisted `IntegrationStore` для integration runs, conflicts, bounded repair tasks и verified integration summary;
- dynamic Integrator role поверх свободного Worker tab без permanent integration agent;
- unique integration branch `orchestra/<projectId>/integration/<integrationRunId>`;
- deterministic DAG-derived integration order с foundation/API/schema priority среди одновременно доступных tasks;
- versioned `IntegrationPrompts` contract с mandatory `git merge --no-ff --no-edit` composition;
- independently verified task-commit ancestry и first-parent merge order;
- structured `CONFLICT` handling для text и semantic incompatibility;
- responsible upstream task attribution для text conflicts по current task + approved artifact file ownership;
- explicit semantic responsibility contract с failed-check evidence;
- persisted bounded `integration-repair-*` tasks, default max 2 repairs per integration run;
- integration verification command aggregation из repository discovery и task verification contracts;
- privileged Event Bus boundary для `taskId=integration` и integration route events;
- fail-safe ambiguous MV3 restart policy с fresh integration run identity вместо uncertain prompt replay;
- `INTEGRATION_VERIFIED` project/scheduler state и integration branch/head visibility в popup;
- Phase 8 architecture doc, smoke test, ADR 0007 и dedicated regression tests;
- `npm run test:phase8`.

### Reliability and safety

- `APPROVED` mutating task без canonical branch/commit provenance fail closed до Integrator dispatch;
- target branch проверяется против immutable Phase 6 base перед integration и перед final acceptance;
- Integrator не пишет напрямую в target branch; alpha.9 policy фиксирована как `integration_branch_only`;
- squash/rebase/cherry-pick task composition запрещены, чтобы reviewed task commits оставались independently verifiable ancestors;
- integration `DONE` не принимается только по LLM report: remote branch head, merge base, changed files, task ancestry и first-parent merge history проверяются через GitHub REST;
- integration changed files ограничены union уже approved task artifact files;
- text conflict обязан сообщить exact merged prefix/current task/files и создаёт отдельный repair turn;
- semantic conflict без explicit responsible task attribution переводится в `NEEDS_USER`, а не угадывает виновника;
- exhausted repair budget переводит integration в `NEEDS_USER` вместо бесконечного remediation loop;
- unbound integration events отклоняются до eventId/idempotency reservation;
- ambiguous persisted `ASSIGNED`/`REPAIR_PENDING` integration state после MV3 restart abandon'ится вместо повторной отправки potentially delivered prompt.

### Changed

- prerelease version обновлена до `2.0.0-alpha.9`;
- project lifecycle после Phase 7 продолжается `READY_FOR_INTEGRATION -> INTEGRATING -> INTEGRATION_REPAIRING? -> INTEGRATION_VERIFIED`;
- `READY_FOR_INTEGRATION` больше не считается terminal состоянием для старта другого проекта;
- service worker загружает Integrator prompts/policy/store/engine/recovery modules и запускает integration после Review/Scheduler initialization;
- popup показывает integration branch и verified head;
- успешный Phase 8 завершает verified composition, но не меняет target branch.

### Known limitations

- initial GitHub provider остаётся read-only/unauthenticated для independent verification; private/unavailable repositories fail closed;
- semantic repair намеренно ограничен уже approved artifact file union и не выполняет широкие архитектурные refactors;
- automated promotion verified integration branch в target branch отсутствует по policy;
- full user-driven Pause/Resume/Stop/reconciliation остаётся Phase 9.

### Not yet implemented

- project-wide Pause / Stop Now / Resume UI and state machine;
- browser-restart reconciliation всех active Worker/Reviewer/Integrator runs;
- automatic safe target-branch promotion policy;
- Dashboard/observability and context-compaction phases.

---

## [2.0.0-alpha.8] - 2026-09-12

### Added

- persisted `ReviewStore` с independent review identities и review history;
- dynamic Reviewer role поверх свободных Worker tabs без permanent fifth agent;
- hard invariant `reviewerAgentId != authorAgentId`;
- versioned `ReviewPrompts` contract с structured acceptance-criteria verdict;
- bounded review packet: task, acceptance criteria, architecture rules, Worker summary/tests/limitations, validated artifact и provider-derived diff;
- `DONE_BY_WORKER -> REVIEW_PENDING -> REVIEWING -> APPROVED | CHANGES_REQUIRED` task lifecycle;
- dependency unlocking только после `APPROVED`;
- structured review issues и concrete `requiredChanges`;
- rework context с previous artifact/commit и review findings;
- new Worker run + unique branch для каждого rework attempt;
- rework branch start from previous reviewed artifact commit;
- configurable bounded review iterations, default `3`;
- `READY_FOR_INTEGRATION` terminal status для успешно reviewed Phase 7 execution;
- reviewer replacement с fresh `reviewId` после tab loss;
- optional reviewer capability matching hook;
- Phase 7 architecture doc, smoke test, ADR 0006 и regression tests;
- `npm run test:phase7`.

### Reliability and safety

- Worker `DONE` и даже Git-valid artifact больше не считаются acceptance;
- author не может review собственный Worker run;
- incomplete `REVIEW_APPROVED` без каждого acceptance criterion/evidence fail closed;
- `CHANGES_REQUIRED` никогда не разблокирует dependency;
- exhausted review loop переводит task/scheduler/project в `NEEDS_USER`;
- lost Reviewer run помечается abandoned, а retry получает fresh protocol identity, поэтому late stale response не может принять replacement review;
- upgrade с alpha.7 не превращает старый `DONE_UNVERIFIED` напрямую в `APPROVED`;
- mutating legacy completion без canonical Git provenance остаётся fail-closed;
- Phase 7 не выполняет merge/rebase/cherry-pick и не пишет в target branch.

### Changed

- prerelease version обновлена до `2.0.0-alpha.8`;
- `DONE_UNVERIFIED` execution semantics заменены на `DONE_BY_WORKER` + mandatory independent review;
- `SchedulerStore.dependenciesSatisfied()` теперь требует `APPROVED`;
- scheduler capacity учитывает active Reviewer slots;
- reviews получают первую возможность занять свободный slot перед dispatch нового runnable work;
- `maxWorkers=1` сохраняет concurrency 1, но Orchestra держит второй connected Worker tab для independent review;
- popup показывает approved count и active/pending review progress;
- all-approved execution завершается как `READY_FOR_INTEGRATION`, а не `MERGED`/`VERIFIED`.

### Known limitation

Approved task branches всё ещё остаются изолированными. `APPROVED` означает independent task acceptance, но не доказывает, что несколько approved branches семантически совместимы после объединения. Это ответственность Phase 8 Integrator.

### Not yet implemented

- integration branch and deterministic merge ordering;
- merge/rebase/cherry-pick execution;
- semantic cross-task conflict classification and repair;
- final target-branch policy;
- full project Pause/Resume/reconciliation.

---

## [2.0.0-alpha.7] - 2026-09-12

### Added

- `GitProvider` boundary и первая read-only реализация `GitHubRestProvider`;
- immutable execution base snapshot: default branch + exact base SHA;
- deterministic branch naming `orchestra/<projectId>/<taskId>/<runId>`;
- persisted per-run Git provenance в SchedulerStore;
- Worker prompt contract v2 с обязательной task branch для mutating runs;
- independent validation remote branch head vs reported commit;
- merge-base / ahead / behind freshness validation;
- changed-files validation против `scope.allow` и `scope.deny`;
- exact comparison Worker-reported `changedFiles` vs GitHub compare;
- target-branch movement detection;
- artifact validation audit в scheduler decision log;
- popup Git base indicator;
- Phase 6 architecture doc, smoke-test, ADR 0005 и regression tests;
- `npm run test:phase6`.

### Reliability and safety

- Worker `DONE` не переводит mutating task в `DONE_UNVERIFIED`, пока remote Git artifact не прошёл независимую validation;
- wrong branch, malformed commit SHA, missing remote branch, head mismatch, wrong merge base, out-of-scope files и false changed-files report отклоняются;
- `target_branch_moved` переводит execution в `NEEDS_USER` вместо silent rebase;
- provider/auth/network/rate-limit failures fail closed и не превращаются в trusted Worker report;
- retry создаёт новый `runId`, следовательно новую task branch identity;
- abandoned task branches сохраняются по policy `retain_until_review_or_manual_cleanup`;
- extension не хранит GitHub credentials и не выполняет GitHub write API calls.

### Changed

- prerelease version обновлена до `2.0.0-alpha.7`;
- manifest добавляет host permission `https://api.github.com/*` для read-only artifact verification;
- `SchedulerStore` хранит execution Git snapshot, run branch metadata и artifact validation result;
- `SchedulerEngine` проверяет base freshness до нового dispatch и Git artifact перед task completion;
- `WorkerPrompts` запрещает direct target-branch writes и требует pushed per-run branch metadata;
- `DONE_UNVERIFIED` теперь означает «Git artifact validated, но ещё не independently reviewed».

### Known limitation

Initial GitHub REST validation is unauthenticated. Private/unavailable repositories fail closed until a future authenticated provider/connector is introduced.

### Not yet implemented

- independent Reviewer approval / `CHANGES_REQUIRED` loop;
- integration branch, merge/rebase/cherry-pick and semantic conflict resolution;
- full project Pause/Resume/reconciliation;
- automated safe cleanup of abandoned branches.

---

## [2.0.0-alpha.6] - 2026-09-12

### Added

- persisted `SchedulerStore` с mutable task/run state отдельно от approved Phase 4 DAG;
- conflict-aware `SchedulerEngine` с runnable queue и адресным Worker assignment;
- configurable `maxWorkers` от 1 до 4;
- candidate ordering по downstream unlock, priority и risk;
- dependency unlocking после Phase 5 transitional status `DONE_UNVERIFIED`;
- explicit/inferred resource locks и file-scope overlap heuristic;
- persisted scheduler decision log;
- retryable `BLOCKED`/`ERROR`, retry budget и `NEEDS_USER` escalation;
- MV3 `alarms` watchdog с default timeout 20 минут;
- heartbeat-aware timeout detection через `TabRegistry.lastSeenAt`;
- immediate retry path для active run, чей Worker исчез между service-worker restarts;
- versioned Worker prompt contract с exact `projectId/taskId/runId/agentId` binding;
- popup `Start Execution` и execution counters;
- Phase 5 scheduler docs, smoke-test, ADR 0004 и regression tests.

### Reliability and safety

- scheduler никогда не назначает одну Worker identity двум active runs одновременно;
- задачи с overlapping scope или shared resource locks не выполняются параллельно;
- Worker `DONE` не превращается в `APPROVED`, `MERGED` или `VERIFIED`;
- длинная живая ChatGPT generation не timeout'ится, пока зарегистрированная вкладка продолжает heartbeat;
- tab close во время run считается failed attempt, а не completion;
- exhausted retry budget и explicit `NEEDS_USER` останавливают новые assignments;
- Phase 5 Worker prompt запрещает unsafe direct push/merge в target branch до появления Phase 6 Git isolation.

### Changed

- prerelease version обновлена до `2.0.0-alpha.6`;
- manifest добавляет permission `alarms` для scheduler watchdog;
- Project Store умеет отражать `RUNNING`, `NEEDS_USER` и `COMPLETED_UNVERIFIED` execution status;
- service worker загружает conflict policy, scheduler store/engine и Worker prompt contracts;
- public orchestrator state содержит scheduler summary;
- Worker slots в popup одновременно определяют `maxWorkers` при старте execution.

### Not yet implemented

- per-task Git branch isolation / commit validation;
- independent review approval;
- integration/merge and semantic conflict handling;
- general Pause/Resume and user-resolution flow;
- verified terminal project state.

---

## [2.0.0-alpha.5] - 2026-09-12

### Added

- persisted `ProjectStore` с immutable initial goal и normalized GitHub repository identity;
- popup `Project Bootstrap` для `goal + repository`;
- staged planning pipeline `DISCOVERY -> PLAN_V1 -> CRITIQUE -> PLAN_V2 -> DECOMPOSE -> DAG_CRITIC`;
- versioned planning prompts и stage-specific persisted input artifacts;
- автоматическая привязка Lead к `projectId/taskId/runId` каждого planning run;
- bounded `@@ORCH_ARTIFACT_BEGIN/END` framing для больших planning artifacts без расширения Protocol v1 envelope;
- planning artifact provenance в accepted Event Store records для crash-window recovery;
- deterministic DAG validator с cycle/dependency/scope/acceptance/verification/complexity/migration/objective-coverage gates;
- persisted final task graph и validation result;
- `agentsMdProposal` как proposal-only planning artifact без автоматической перезаписи existing `AGENTS.md`;
- Phase 4 unit/regression tests для Project Store, artifact parser, event provenance, DAG validation, full six-stage pipeline и service-worker recovery scenario;
- dedicated Phase 4 architecture document and ADR 0003.

### Reliability and safety

- `READY` выставляется только после deterministic DAG validation, а не по заявлению Lead;
- stale output предыдущей planning stage/run отклоняется Phase 3 protocol context binding;
- large plan/DAG не помещается внутрь маленького `@@ORCH` envelope;
- `BLOCKED`, `ERROR` и `NEEDS_USER` planning events не требуют artifact block;
- restart после accepted planning event может восстановить artifact из Event Store и продолжить со следующей stage без повторной отправки уже обработанного prompt;
- `PlanningEngine.init()` идемпотентен и не создаёт повторные Event Bus subscriptions;
- Phase 4 не назначает DAG tasks workers и не запускает scheduler раньше Phase 5.

### Changed

- prerelease version обновлена до `2.0.0-alpha.5`;
- service worker загружает Project Store, Planning Engine, DAG validator и planning prompt contracts;
- public orchestrator state содержит active project summary;
- popup показывает project status/stage/task count;
- Event Store source metadata может хранить bounded planning artifact для recovery.

### Not yet implemented

- parallel task scheduler и dependency unlocking;
- automatic Worker task assignment;
- Git task branches/artifact validation;
- review/integration loops;
- full project Pause/Resume and reconciliation.

---

## [2.0.0-alpha.4] - 2026-09-12

### Added

- Orchestra Protocol v1 с префиксом `@@ORCH`;
- JSON envelope и compact fallback syntax;
- обязательные `projectId`, `taskId`, `runId`, `agentId`, `eventId`, `sequence`;
- persisted `EventStore` и `EventBus` в `chrome.storage.local`;
- route classification для lifecycle/progress/completion/blocker/review/integration/user events;
- persisted `processedEvents`, monotonic sequence tracking и event cursor;
- exact duplicate suppression после перезапуска service worker;
- rejection log для malformed/stale/foreign protocol events;
- protocol context binding `projectId/taskId/runId` к конкретному agent;
- regression tests для parser, duplicate replay, eventId collision, stale sequence, sender mismatch и persisted replay.

### Safety

- protocol обрабатывается только из последней непустой строки assistant response;
- неизвестная версия/event type отклоняется без side effect;
- незарегистрированный tab не может публиковать Orchestra events;
- `agentId` в envelope обязан совпасть с registry identity sender tab;
- если agent имеет protocol context, stale/чужие `projectId/taskId/runId` отклоняются;
- одинаковый `eventId` с другим payload считается collision, а не duplicate;
- sequence, идущий назад или повторяющийся в рамках run, отклоняется;
- malformed protocol сохраняется в rejection audit вместо автоматического действия.

### Changed

- prerelease version обновлена до `2.0.0-alpha.4`;
- `ProtocolParser` сначала распознаёт Orchestra Protocol и только затем legacy rules;
- `ChatGPTAdapter` публикует protocol result после подтверждённого generation completion;
- service worker загружает protocol/event store до обработки runtime events;
- legacy `DONE/FAIL/ERROR` остаётся compatibility fallback.

### Not yet implemented

- project bootstrap и Planner/Critic;
- task DAG/scheduler;
- автоматическое назначение protocol context scheduler'ом;
- Git branch isolation;
- review/integration loops;
- Pause/Resume и full project recovery.

---

## [2.0.0-alpha.3] - 2026-09-12

### Added

- Manifest V3 service worker как центральный runtime coordinator;
- persistent `TabRegistry` в `chrome.storage.local`;
- стабильные `agentId` и mapping `agentId <-> tabId <-> chatUrl`;
- явная роль Lead и до четырёх Worker slots;
- создание Worker-вкладок через безопасный pre-bind перед navigation в ChatGPT;
- heartbeat зарегистрированных агентов и состояния `CONNECTING/IDLE/BUSY/OFFLINE/ERROR`;
- recovery registry после рестарта service worker;
- обработка reload, close и navigation зарегистрированных вкладок;
- адресная отправка prompt/stop command конкретному `agentId`;
- Phase 2 controls/status в popup;
- unit tests для persistence, registration safety, lifecycle и targeted routing.

### Safety

- обычная пользовательская вкладка ChatGPT не становится агентом автоматически;
- Lead назначается только явной командой пользователя;
- Worker регистрируется по `tabId` до перехода с `about:blank` на ChatGPT;
- незарегистрированные вкладки не запускают периодический heartbeat;
- runtime messages от неизвестных ChatGPT tabs игнорируются orchestrator'ом.

### Changed

- manifest запрашивает `tabs` и объявляет background service worker;
- prerelease version обновлена до `2.0.0-alpha.3`;
- popup теперь показывает состояние Lead/Workers, не заменяя legacy flag settings.

### Not yet implemented

- Orchestra Protocol v1 / event bus;
- project bootstrap и Planner/Critic;
- task DAG и scheduler;
- Git branch isolation;
- review/integration loops;
- полноценные Pause/Resume semantics и crash recovery проекта.

---

## [2.0.0-alpha.2] - 2026-09-12

### Added

- модульный content adapter layer: `GenerationDetector`, `ComposerAdapter`, `AssistantMessageReader`, `ProtocolParser`, `ChatGPTAdapter`;
- централизованный selector registry с fallback selectors;
- deterministic generation state machine;
- typed content/background message names и runtime command boundary;
- structured diagnostic logging;
- zero-dependency Node test harness для deterministic core;
- тесты parser/state machine/composer safety/response fingerprinting/SPA navigation baseline.

### Reliability

- legacy completion больше не зависит только от того, успело ли расширение заметить `stop-button`;
- изменение fingerprint нового assistant response является вторым независимым completion signal;
- completion принимается только после quiet/stability window;
- существующий response при загрузке страницы используется как baseline и не запускает старый `DONE`;
- переход между существующими ChatGPT conversations в SPA создаёт новый baseline и не трактуется как свежий completion;
- одинаковый текст в двух разных assistant turns имеет разные fingerprints за счёт message count.

### Changed

- `content.js` теперь только bootstrap/runtime command boundary;
- legacy `DONE/FAIL/ERROR` policy вынесена в `LegacyController` и работает поверх `ChatGPTAdapter`;
- manifest загружает content modules в явном порядке;
- prerelease version обновлена до `2.0.0-alpha.2`.

### Preserved

- точное case-sensitive сопоставление legacy-флагов;
- randomized delay перед действием;
- дополнительная stability-проверка ответа;
- защита от перезаписи пользовательского текста в composer;
- `FAIL` notification behavior;
- локальная конфигурация правил.

---

## [2.0.0-alpha.1] - 2026-09-12

### Changed

- проект переименован в **ChatGPT Orchestra**;
- обновлены extension title, popup branding и diagnostic log prefix;
- repository URLs и badges переведены на `VadimAlekseyevich/ChatGPT-Orchestra`;
- README переписан вокруг целевой multi-agent архитектуры;
- существующий single-tab flag runner формально обозначен как **legacy foundation**, а не конечный продукт;
- принят versioning policy для новой архитектурной линии;
- добавлены `ROADMAP.md`, `CHANGELOG.md` и структура `docs/adr/`.

### Preserved

Legacy baseline продолжает поддерживать:

- `DONE`, `FAIL`, `ERROR` и пользовательские правила;
- автоматическую отправку follow-up prompt;
- уведомление пользователя;
- randomized delay;
- local duplicate-response guard;
- защиту непустого composer;
- локальное хранение конфигурации.

### Not yet implemented

В этой alpha пока отсутствуют:

- multi-tab Orchestrator Core;
- agent registry;
- Orchestra Protocol;
- Planner/Critic/DAG pipeline;
- parallel scheduler;
- Git task isolation;
- review/integration loops;
- pause/resume и crash recovery.

Следующие изменения должны реализовываться по фазам из `ROADMAP.md`.

---

## Legacy baseline — 1.2.0

Версия до переименования проекта. Реализовала configurable single-tab response flags, `DONE/FAIL/ERROR`, notifications, automatic follow-ups, randomized delay и local storage configuration.

Исторические версии до `2.0.0-alpha.1` рассматриваются как foundation нового проекта, а не как отдельная целевая продуктовая линия.