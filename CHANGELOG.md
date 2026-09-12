# Changelog

Все заметные изменения ChatGPT Orchestra фиксируются в этом файле.

Формат основан на принципах Keep a Changelog. Новая multi-agent архитектура развивается как линия `2.x`; prerelease-имя хранится в `manifest.version_name`.

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
