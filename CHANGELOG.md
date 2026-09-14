# Changelog

Все заметные изменения ChatGPT Orchestra фиксируются в этом файле.

Формат основан на принципах Keep a Changelog. Новая multi-agent архитектура развивается как линия `2.x`; prerelease-имя хранится в `manifest.version_name`.

## [2.0.0-alpha.20] - 2026-09-14

### Added

- packaged Windows desktop-first product path на Electron/Node с managed ChatGPT browser profile;
- desktop control plane с SQLite persistence и Orchestrator API IPC boundary;
- optional authenticated extension companion runtime как fallback/migration bridge;
- local repository registry, open-local/clone-by-URL flow, system Git adapter и isolated task/integration worktrees;
- local verification command runner с explicit repository trust, argv-only execution, timeout/output bounds, cancellation и audit metadata;
- direct desktop `AgentRuntime` с Lead/Worker logical agents, prompt/stop/completion handling, browser/session recovery и parity coverage;
- desktop first-project UX: Lead readiness gate, local folder picker, GitHub `origin` auto-detection, Goal → Start Project flow и 1–4 Worker execution control;
- terminal project lifecycle UX для запуска следующего проекта без удаления предыдущей persisted history;
- Windows NSIS candidate packaging, signature evidence и отдельный strict signed-release workflow;
- Phase 20 release contract с 17 roadmap acceptance scenarios и dedicated `test:phase20` / `test:alpha` gates.

### Reliability and safety

- desktop runtime является primary product path; extension не является canonical project state owner;
- Core остаётся отделён от Electron/browser handles через platform contracts;
- local filesystem paths остаются desktop runtime metadata и не попадают в portable project state;
- local mutating work выполняется в isolated Git worktrees, а changed-files provenance проверяется независимо от agent report;
- review и integration сохраняют independent-author/integrator policy и deterministic no-ff semantics;
- dirty abandoned worktrees salvage'ятся вместо destructive cleanup;
- Pause/Resume/Stop Now и crash recovery защищены late-event/idempotency boundaries;
- Stop Now сначала отменяет активные local verification processes, затем входит в Core stop boundary;
- managed-browser/worker/app recovery не выполняет irreversible side effect в unknown state;
- renderer остаётся sandboxed/context-isolated, desktop IPC ограничен allowlisted boundary;
- unsigned PR/main CI artifacts являются только candidate evidence; final alpha release требует `Authenticode=Valid`.

### Changed

- prerelease version обновлена до `2.0.0-alpha.20`;
- default desktop runtime переключён на managed-browser; fake shell и companion runtime остаются explicit modes;
- primary onboarding теперь ведёт пользователя от ChatGPT login/Lead registration к открытию или клонированию repository и запуску проекта;
- local repository GitHub URL автоматически определяется из `origin`, когда это возможно;
- завершённый/failed/cancelled active project можно сменить через явный `Start another project` flow;
- extension companion позиционируется как optional fallback, а не основной runtime.

### Validation

- Phase 15–20 suites входят в GitHub Actions alongside Core Node 18/22, contracts, browser fixtures и SQLite/persistence gates;
- Windows CI собирает unpacked app + NSIS installer, stages fallback extension и записывает Authenticode evidence;
- все 17 Phase 20 roadmap scenarios имеют executable automated evidence;
- fresh-install interactive ChatGPT onboarding (A01) и real OS restart/project resume (A11) остаются обязательными manual release scenarios;
- final `v2.0.0-alpha.20` prerelease дополнительно требует strict signed Windows validation с реальным code-signing certificate.

### Next

- завершить manual A01/A11 evidence и strict signed Windows release validation;
- только после успешного desktop alpha переходить к Phase 21 post-alpha cutover/provider expansion.

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
- feature branch перед merge была `behind=0`;
- dedicated `test:phase13` suite добавлена;
- полный repository `npm test` / `npm run test:phase13` из checkout в текущей environment не запускался из-за отсутствующего DNS-доступа к GitHub;
- Edge + standalone Dashboard smoke-test остаётся release gate.

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

- Phase 13 — Context Management + Portable Agent Packets;
- shared Dashboard frontend поверх Orchestrator API;
- no direct UI access to Chrome storage/tabs or SQLite.

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
- Planning/Scheduler/Review/Integration/Recovery больше не создают Chrome dependencies самостоятельно;
- API DTO больше не должны содержать `tabId` как identity source;
- Phase 11 становится следующим roadmap этапом.

### Portability and safety

- Core modules получают platform-specific capabilities через injected contracts;
- runtime commands fail closed, если соответствующий capability не injected;
- Event Bus принимает generic sender identity вместо raw Chrome sender;
- Extension adapters остаются browser boundary, а не частью domain logic;
- target-branch write policy не изменён;
- существующие Phase 1–9 behavior/state machines сохраняются.

### Validation

- unit and focused portability suites added for contracts/adapters/API boundary;
- extension runtime remains the reference parity implementation for Phase 10.

---

## [2.0.0-alpha.10] - 2026-09-12

### Added

- Recovery plane v1: `Pause`, `Resume`, `Stop Now`, startup reconciliation и recovery-mode gating;
- recovery state persisted in `chrome.storage.local`, включая `RECOVERY_REQUIRED` / `NEEDS_USER` issue list;
- Scheduler/Review/Integration reconciliation helpers for orphaned active work;
- late-event rejection by Recovery stop boundaries and event cursor/recovery evidence;
- popup controls for Pause/Resume/Stop Now and recovery issues;
- debug export теперь включает `recovery` snapshot;
- dedicated `npm run test:phase9` suite;
- Phase 9 architecture doc, smoke test and ADR 0009.

### Safety and recovery

- `Pause` is safe-point based: active runs/reviews/integration are allowed to settle, but new dispatch is blocked;
- `Stop Now` seals late protocol events and prevents new side effects;
- startup now enters fail-closed reconciliation before any new scheduling;
- unknown/orphaned execution state is surfaced as `NEEDS_USER` instead of silently retried;
- per-run recovery deadlines and bounded retry/repair policies are preserved across restart;
- integration rejects stale-base artifacts before merge;
- target-branch writes remain user-gated.

### Changed

- prerelease version updated to `2.0.0-alpha.10`;
- runtime API schema updated to support recovery commands/state;
- phases 0–9 remain the browser-extension baseline while desktop-portability work is staged in the new roadmap.

### Validation

- full repository `npm test` passed after recovery changes;
- recovery-specific suite passed with pause/resume/stop/restart and late-event coverage;
- release manifest validation passed for `2.0.0-alpha.10`.

### Next

- Phase 10 — Platform Boundary + Orchestrator API;
- Core must stop depending directly on browser-specific APIs before desktop migration work begins.

---

## [2.0.0-alpha.9] - 2026-09-12

### Added

- ...