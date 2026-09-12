<div align="center">

# ChatGPT Orchestra

Browser-based multi-agent orchestration for ChatGPT coding workflows.

[![Platform](https://img.shields.io/badge/platform-Microsoft%20Edge-0A7EA4?style=for-the-badge)](#требования)
[![Version](https://img.shields.io/badge/version-2.0.0--alpha.2-orange?style=for-the-badge)](CHANGELOG.md)
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

1. пользователь описывает задачу;
2. указывает GitHub-репозиторий;
3. Orchestra помогает построить и раскритиковать roadmap;
4. план декомпозируется в DAG независимых задач;
5. несколько worker-чатов выполняют независимые задачи параллельно;
6. reviewer проверяет результаты;
7. integrator собирает изменения и разбирает текстовые и семантические конфликты;
8. lead следит за общим состоянием и качеством результата;
9. проект можно безопасно поставить на паузу и продолжить после перезапуска браузера.

Ключевая архитектурная идея: **чаты — исполнители, а не источник состояния системы**. Состояние проекта, задачи, события, зависимости и назначения должны принадлежать Orchestrator Core.

Полный архитектурный план находится в [`ROADMAP.md`](ROADMAP.md).

---

## Текущий статус

Текущая prerelease-версия — **`2.0.0-alpha.2`**.

Phase 1 выделила ChatGPT DOM automation в отдельный adapter layer. Legacy `DONE/FAIL/ERROR` runner по-прежнему является compatibility foundation, но теперь работает поверх детерминированных компонентов вместо монолитного `content.js`.

Это **ещё не multi-agent orchestrator**: service worker, tab registry, event bus, scheduler, Git isolation и recovery относятся к следующим фазам.

| Область | Статус |
|---|---|
| Legacy `DONE/FAIL/ERROR` runner | Реализован поверх adapter layer |
| Пользовательские флаги | Реализованы |
| Автоматическая отправка follow-up | Реализована |
| Уведомление пользователя | Реализовано |
| ChatGPT adapter layer | Реализован — Phase 1 |
| Deterministic generation state | Реализован — Phase 1 |
| Missed-busy completion fallback | Реализован — Phase 1 |
| SPA stale-response baseline | Реализован — Phase 1 |
| Core unit tests | Добавлены — Phase 1 |
| Service Worker Orchestrator | Следующий этап — Phase 2 |
| Multi-tab agent registry | Phase 2 |
| Orchestra Protocol | Phase 3 |
| Planner/Critic/DAG | Phase 4 |
| Parallel workers | Phase 5 |
| Git isolation/review/integration | Phase 6–8 |
| Pause/Resume + crash recovery | Phase 9 |

---

## Legacy foundation

Текущая реализация умеет:

- обнаруживать начало и окончание генерации ChatGPT;
- читать последний assistant response;
- сопоставлять последнюю непустую строку с legacy rules;
- автоматически отправлять follow-up prompt;
- уведомлять пользователя для блокирующего состояния;
- поддерживать базовые `DONE`, `FAIL`, `ERROR` и пользовательские флаги;
- не перезаписывать текст, который пользователь уже ввёл в composer;
- хранить настройки через `chrome.storage.local`;
- применять изменения настроек без перезагрузки вкладки.

### Что изменилось в alpha.2

Раньше completion практически зависел от перехода `stop-button visible -> stop-button hidden`. Если расширение не успевало увидеть busy-состояние, завершённый `DONE` мог остаться необработанным.

Теперь `GenerationDetector` использует два сигнала:

1. явный generation/busy signal через fallback selectors;
2. изменение fingerprint последнего assistant response.

Если busy-сигнал был пропущен, новый response всё равно становится кандидатом на completion после quiet/stability window. При этом старый ответ при загрузке и response из другого уже существующего чата после SPA-navigation используются как baseline и не вызывают автоматическое действие.

Это уменьшает вероятность пропущенного `DONE`, не превращая любой DOM mutation в completion.

### Базовые правила

| Флаг | Действие | Значение по умолчанию |
|---|---|---|
| `DONE` | Отправить промпт | `Делай следующее задание` |
| `FAIL` | Позвать пользователя | `Требуется ваше участие. Откройте чат ChatGPT.` |
| `ERROR` | Отправить промпт | Попытаться исправить ошибку и продолжить |

Legacy-флаг должен находиться в последней непустой строке ответа и совпадать точно, включая регистр.

---

## Архитектура content layer

Phase 1 разделила прежний монолитный `content.js`:

```text
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
content.js                 # bootstrap only
```

`ChatGPTAdapter` является границей между DOM ChatGPT и будущим Orchestrator Core. DOM selectors, чтение response и отправка prompt больше не должны проникать в scheduler/orchestration code.

---

## Roadmap

Разработка идёт по фазам, описанным в [`ROADMAP.md`](ROADMAP.md).

Ближайшие этапы:

- **Phase 0 — Repository reset / Rename hygiene** — завершена;
- **Phase 1 — Adapter extraction and deterministic core** — завершена в `2.0.0-alpha.2`;
- **Phase 2 — Service Worker Orchestrator + Tab Registry** — следующий этап;
- **Phase 3 — Orchestra Protocol v1 + Event Bus** — machine-readable events, idempotency и routing;
- **Phase 4+** — Planner/Critic, DAG, scheduler, Git isolation, review, integration и recovery.

---

## Быстрый старт

1. Клонируй репозиторий:

```powershell
git clone https://github.com/VadimAlekseyevich/ChatGPT-Orchestra.git
cd ChatGPT-Orchestra
```

2. Открой в Microsoft Edge:

```text
edge://extensions/
```

3. Включи **Режим разработчика / Developer mode**.
4. Нажми **Загрузить распакованное / Load unpacked**.
5. Выбери папку репозитория, где находится `manifest.json`.
6. После обновления исходников нажми **Reload** у расширения и обнови открытые ChatGPT tabs.
7. Открой popup расширения и настрой legacy-флаги.

Для запуска core tests нужен Node.js 18+:

```powershell
npm test
```

Runtime extension по-прежнему не требует npm dependencies или build step.

---

## Требования

- Microsoft Edge с поддержкой Manifest V3 extensions;
- Developer mode для установки из исходников;
- доступ к `https://chatgpt.com/` или `https://chat.openai.com/`;
- Node.js 18+ только для development tests.

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

## Безопасность текущего baseline

Compatibility runner намеренно консервативен:

- не перезаписывает непустой composer;
- не отправляет prompt пока ChatGPT генерирует ответ;
- проверяет стабильность response перед side effect;
- старый response при загрузке становится baseline;
- navigation в существующий chat не считается новым response completion;
- хранит настройки локально;
- не требует API-ключа или внешнего backend;
- имеет доступ только к доменам ChatGPT из manifest.

Будущая Orchestra-архитектура дополнит это persisted state, idempotent events, state machines, retry budgets, reconciliation и circuit breakers.

---

## Приватность

Текущая версия:

- хранит настройки через `chrome.storage.local`;
- читает DOM ChatGPT только для работы automation;
- не имеет собственного внешнего сервера;
- самостоятельно не отправляет содержимое чатов сторонним сервисам.

По мере появления интеграций требования к данным и permissions будут документироваться отдельными ADR.

---

## Диагностика

Открой DevTools (`F12`) на вкладке ChatGPT и найди записи с префиксом:

```text
[ChatGPT Orchestra]
```

С alpha.2 логи структурированы. Полезные event names:

```text
generation_detector_started
generation_started
generation_stopped
assistant_response_completed
conversation_navigation_baseline
legacy_flag_check_scheduled
legacy_follow_up_sent
legacy_follow_up_skipped
legacy_duplicate_suppressed
```

Если `DONE` снова будет пропущен, особенно полезны события `response_changed`, `assistant_response_completed` и `legacy_flag_not_matched` вокруг проблемного ответа.

---

## Версионирование

Новая multi-agent архитектура развивается как **2.x**.

Для Manifest V3 используется числовое поле:

```json
"version": "2.0.0"
```

А человекочитаемый prerelease хранится в:

```json
"version_name": "2.0.0-alpha.2"
```

Подробное решение зафиксировано в [`docs/adr/0001-versioning-policy.md`](docs/adr/0001-versioning-policy.md).

Изменения по версиям ведутся в [`CHANGELOG.md`](CHANGELOG.md).

---

## Документация и архитектурные решения

- [`ROADMAP.md`](ROADMAP.md) — целевая архитектура и phased implementation plan;
- [`CHANGELOG.md`](CHANGELOG.md) — история изменений;
- [`docs/README.md`](docs/README.md) — индекс документации;
- [`docs/adr/`](docs/adr/) — Architecture Decision Records.

---

## Ограничения текущей версии

- multi-agent orchestration ещё не реализована;
- extension всё ещё зависит от production DOM ChatGPT;
- selector fallback снижает, но не устраняет риск UI breakage;
- duplicate protection legacy runner пока локален для content script, а не глобален для project event bus;
- отсутствуют scheduler, persisted project state, Git isolation и crash recovery;
- автоматическая обработка флага не доказывает корректность ответа модели;
- browser E2E against real ChatGPT пока остаётся ручным smoke test.

---

## Обратная связь

Ошибки, идеи и архитектурные предложения можно создавать через [GitHub Issues](../../issues).

Для bug report полезно приложить:

- браузер и версию;
- версию ChatGPT Orchestra;
- ожидаемое и фактическое поведение;
- релевантные сообщения `[ChatGPT Orchestra]` из Console;
- минимальный сценарий воспроизведения.

---

## Лицензия

Проект распространяется по лицензии [MIT](LICENSE).
