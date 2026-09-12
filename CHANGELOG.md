# Changelog

Все заметные изменения ChatGPT Orchestra фиксируются в этом файле.

Формат основан на принципах Keep a Changelog. Новая multi-agent архитектура развивается как линия `2.x`; prerelease-имя хранится в `manifest.version_name`.

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
- `agentId` в envelope обязан совпадать с registry identity sender tab;
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
