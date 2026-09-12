<div align="center">

# ChatGPT Orchestra

Browser-based multi-agent orchestration for ChatGPT coding workflows.

[![Platform](https://img.shields.io/badge/platform-Microsoft%20Edge-0A7EA4?style=for-the-badge)](#требования)
[![Version](https://img.shields.io/badge/version-2.0.0--alpha.3-orange?style=for-the-badge)](CHANGELOG.md)
[![License](https://img.shields.io/github/license/VadimAlekseyevich/ChatGPT-Orchestra?style=for-the-badge&label=license)](LICENSE)

[Roadmap](ROADMAP.md) ·
[Changelog](CHANGELOG.md) ·
[Документация](docs/README.md) ·
[Issues](../../issues)

</div>

---

## Идея

**ChatGPT Orchestra** — расширение Manifest V3, цель которого — превратить несколько ChatGPT-чатов в управляемый оркестр coding-agent'ов.

Целевой сценарий:

1. пользователь описывает задачу и указывает GitHub-репозиторий;
2. Orchestra строит, критикует и уточняет план;
3. план декомпозируется в DAG независимых задач;
4. несколько worker-чатов выполняют независимые задачи параллельно;
5. reviewer проверяет результаты;
6. integrator собирает изменения и разбирает текстовые и семантические конфликты;
7. lead контролирует общее состояние и качество результата;
8. проект можно безопасно поставить на паузу и продолжить после перезапуска браузера.

Ключевая архитектурная идея: **чаты — исполнители, а не источник состояния системы**. Состояние проекта, задачи, события, зависимости и назначения должны принадлежать Orchestrator Core.

Полный архитектурный план находится в [`ROADMAP.md`](ROADMAP.md).

---

## Текущий статус

Текущая prerelease-версия — **`2.0.0-alpha.3`**.

Phase 1 выделила DOM ChatGPT в отдельный adapter layer и усилила completion detection. Phase 2 добавила центральный Manifest V3 service worker и persistent agent tab registry.

Это уже multi-tab orchestration foundation, но **ещё не автономный task orchestrator**: Orchestra Protocol, event bus, project bootstrap, DAG scheduler, Git isolation, review/integration и project recovery относятся к следующим фазам.

| Область | Статус |
|---|---|
| Legacy `DONE/FAIL/ERROR` runner | Реализован поверх adapter layer |
| ChatGPT adapter layer | Реализован — Phase 1 |
| Missed-busy completion fallback | Реализован — Phase 1 |
| Service Worker Orchestrator | Реализован — Phase 2 |
| Persistent agent/tab registry | Реализован — Phase 2 |
| Explicit Lead registration | Реализована — Phase 2 |
| До 4 Worker tabs | Реализовано — Phase 2 |
| Agent heartbeat/health | Реализован — Phase 2 |
| Targeted prompt routing by `agentId` | Реализован — Phase 2 |
| Orchestra Protocol / Event Bus | Следующий этап — Phase 3 |
| Planner/Critic/DAG | Phase 4 |
| Parallel task scheduler | Phase 5 |
| Git isolation/review/integration | Phase 6–8 |
| Pause/Resume + crash recovery проекта | Phase 9 |

---

## Phase 2: Agent Pool

Popup теперь умеет явно связать текущую ChatGPT-вкладку с ролью **Lead** и создать до четырёх **Worker**-вкладок.

Главные правила безопасности:

- обычная вкладка ChatGPT не становится агентом автоматически;
- Lead назначается только явным действием пользователя;
- Worker сначала получает `agentId` и `tabId`, и только затем вкладка переводится на ChatGPT;
- незарегистрированные вкладки не запускают периодический heartbeat;
- закрытый Worker становится `OFFLINE`, но его логическая identity не удаляется;
- повторное создание worker pool может перепривязать OFFLINE worker к новой вкладке;
- prompt адресуется по `agentId`, а registry разрешает его в конкретный `tabId`.

Health-состояния Phase 2:

```text
CONNECTING
IDLE
BUSY
ERROR
OFFLINE
```

Это состояния транспорта/вкладки, а не будущие task states.

Подробный контракт: [`docs/phase-2-tab-registry.md`](docs/phase-2-tab-registry.md).

---

## Legacy foundation и надёжность DONE

Legacy `DONE/FAIL/ERROR` остаётся compatibility layer.

Phase 1 исправила ключевой failure mode: completion больше не зависит только от того, успело ли расширение заметить `stop-button`. `GenerationDetector` использует два сигнала:

1. явный generation/busy signal через fallback selectors;
2. изменение fingerprint последнего assistant response.

Если busy-сигнал был пропущен, новый response всё равно становится кандидатом на completion после quiet/stability window. Старый ответ при загрузке и response после SPA-navigation используются как baseline и не вызывают автоматическое действие.

Базовые правила:

| Флаг | Действие | Значение по умолчанию |
|---|---|---|
| `DONE` | Отправить промпт | `Делай следующее задание` |
| `FAIL` | Позвать пользователя | `Требуется ваше участие. Откройте чат ChatGPT.` |
| `ERROR` | Отправить промпт | Попытаться исправить ошибку и продолжить |

Legacy-флаг должен находиться в последней непустой строке ответа и совпадать точно, включая регистр.

---

## Архитектура текущей alpha

```text
background/
  service-worker.js
  orchestrator.js
  tab-registry.js

content/
  selectors.js
  utils.js
  logger.js
  message-types.js
  generation-state.js
  generation-detector.js
  assistant-message-reader.js
  composer-adapter.js
  protocol-parser.js
  runtime-messenger.js
  chatgpt-adapter.js
  legacy-controller.js

content.js                 # content bootstrap + addressed runtime commands
popup-orchestrator.js      # Phase 2 pool controls
```

`ChatGPTAdapter` изолирует production DOM ChatGPT. `ServiceWorkerOrchestrator` управляет известными агентами, а `TabRegistry` является persistent transport source of truth для связи `agentId <-> tabId <-> chatUrl`.

Phase 3 должна строиться поверх этих границ, а не возвращать orchestration logic обратно в DOM/content layer.

---

## Roadmap

Разработка идёт по фазам из [`ROADMAP.md`](ROADMAP.md):

- **Phase 0** — Repository reset / Rename hygiene — завершена;
- **Phase 1** — Adapter extraction and deterministic core — завершена в `2.0.0-alpha.2`;
- **Phase 2** — Service Worker Orchestrator + Tab Registry — реализована в `2.0.0-alpha.3`;
- **Phase 3** — Orchestra Protocol v1 + Event Bus — следующий этап;
- **Phase 4+** — project bootstrap, Planner/Critic, DAG scheduler, Git isolation, review, integration и recovery.

---

## Быстрый старт

1. Клонируй репозиторий:

```powershell
git clone https://github.com/VadimAlekseyevich/ChatGPT-Orchestra.git
cd ChatGPT-Orchestra
```

2. Открой `edge://extensions/`, включи Developer mode и выбери **Load unpacked**.
3. Выбери папку репозитория с `manifest.json`.
4. После обновления исходников нажми **Reload** у расширения и обнови открытые ChatGPT tabs.
5. Открой нужный ChatGPT-чат, затем popup и нажми **Эту вкладку → Lead**.
6. Выбери число Workers и нажми **Создать Workers**.
7. Следи за состояниями Lead/Workers в popup.

Для development tests нужен Node.js 18+:

```powershell
npm test
```

Runtime extension не требует npm dependencies или build step.

---

## Требования и permissions

- Microsoft Edge с поддержкой Manifest V3;
- Developer mode для установки из исходников;
- доступ к `https://chatgpt.com/` или `https://chat.openai.com/`;
- Node.js 18+ только для development tests.

Manifest использует:

- `storage` — настройки и persistent TabRegistry;
- `tabs` — создание, адресация и lifecycle зарегистрированных agent tabs;
- host permissions только для доменов ChatGPT.

Другие Chromium-браузеры потенциально совместимы, но пока не являются официально протестированной платформой.

---

## Конфигурация legacy runner

| Параметр | Назначение | Значение по умолчанию |
|---|---|---:|
| Обработка флагов | Глобальное включение automation | Включено |
| Базовая задержка | Пауза после завершения generation event | `1200 мс` |
| Случайная добавка | Дополнительная задержка | `0…1200 мс` |
| Stability window | Дополнительная проверка неизменности response | `650 мс` |
| Правила | Флаг + действие + payload | `DONE`, `FAIL`, `ERROR` |

Старые настройки `marker` и `followUp` автоматически мигрируют в текущий формат `rules`.

---

## Диагностика

Открой DevTools (`F12`) на вкладке ChatGPT и найди записи с префиксом:

```text
[ChatGPT Orchestra]
```

Полезные content events:

```text
generation_detector_started
response_changed
assistant_response_completed
conversation_navigation_baseline
legacy_flag_check_scheduled
legacy_follow_up_sent
legacy_follow_up_skipped
legacy_duplicate_suppressed
agent_heartbeat_enabled
```

Для service worker открой его Inspect из `edge://extensions/`.

Если `DONE` снова будет пропущен, особенно полезны `response_changed`, `assistant_response_completed` и `legacy_flag_not_matched` вокруг проблемного ответа.

---

## Версионирование

Новая multi-agent архитектура развивается как **2.x**.

Для Manifest V3 используется числовое поле:

```json
"version": "2.0.0"
```

А человекочитаемый prerelease хранится в:

```json
"version_name": "2.0.0-alpha.3"
```

Подробное решение: [`docs/adr/0001-versioning-policy.md`](docs/adr/0001-versioning-policy.md).

---

## Документация

- [`ROADMAP.md`](ROADMAP.md) — целевая архитектура и phased implementation plan;
- [`CHANGELOG.md`](CHANGELOG.md) — история изменений;
- [`docs/phase-2-tab-registry.md`](docs/phase-2-tab-registry.md) — transport/registry contract Phase 2;
- [`docs/README.md`](docs/README.md) — индекс документации;
- [`docs/adr/`](docs/adr/) — Architecture Decision Records.

---

## Ограничения текущей версии

- Orchestra Protocol v1 и global event idempotency ещё не реализованы;
- task/project source of truth и scheduler ещё не реализованы;
- Worker tabs пока не получают реальные task assignments автоматически;
- automatic worker recreation после crash относится к recovery phase;
- Git isolation, review и integration ещё не реализованы;
- extension зависит от production DOM ChatGPT;
- browser E2E against real ChatGPT пока остаётся ручным smoke test;
- legacy flag completion не доказывает корректность ответа модели.

---

## Лицензия

Проект распространяется по лицензии [MIT](LICENSE).
