<div align="center">

# ChatGPT Orchestra

Browser-based multi-agent orchestration for ChatGPT coding workflows.

[![Platform](https://img.shields.io/badge/platform-Microsoft%20Edge-0A7EA4?style=for-the-badge)](#требования)
[![Version](https://img.shields.io/badge/version-2.0.0--alpha.1-orange?style=for-the-badge)](CHANGELOG.md)
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

Проект находится в начале новой архитектурной линии **`2.0.0-alpha.1`**.

Сейчас репозиторий содержит рабочий legacy foundation: single-tab механизм, который наблюдает завершение генерации ChatGPT, распознаёт служебные флаги и выполняет привязанные действия.

Это **не конечный продукт Orchestra** и пока не multi-agent orchestrator. Legacy-механизм сохраняется специально как проверенный baseline, поверх которого будут строиться adapter layer, service-worker orchestrator, tab registry, event protocol, scheduler и остальные части системы.

| Область | Статус |
|---|---|
| Legacy `DONE/FAIL/ERROR` runner | Реализован |
| Пользовательские флаги | Реализованы |
| Автоматическая отправка follow-up | Реализована |
| Уведомление пользователя | Реализовано |
| Duplicate-response guard внутри вкладки | Реализован |
| ChatGPT adapter layer | Следующий этап |
| Service Worker Orchestrator | Запланирован |
| Multi-tab agent registry | Запланирован |
| Orchestra Protocol | Запланирован |
| Planner/Critic/DAG | Запланирован |
| Parallel workers | Запланированы |
| Git isolation/review/integration | Запланированы |
| Pause/Resume + crash recovery | Запланированы |
| CI и automated tests | Запланированы |

---

## Legacy foundation

Текущая реализация умеет:

- обнаруживать начало и окончание наблюдаемой генерации ChatGPT;
- читать последнюю непустую строку ответа;
- сопоставлять её с включёнными правилами;
- автоматически отправлять follow-up prompt;
- уведомлять пользователя для блокирующего состояния;
- поддерживать базовые `DONE`, `FAIL`, `ERROR` и пользовательские флаги;
- защищаться от повторной обработки уже обработанного ответа внутри текущей вкладки;
- не перезаписывать текст, который пользователь уже ввёл в composer;
- хранить настройки через `chrome.storage.local`;
- применять изменения настроек к открытым вкладкам без перезагрузки.

Эти возможности будут сохранены как compatibility mode во время перехода к Orchestra Protocol.

### Базовые правила

| Флаг | Действие | Значение по умолчанию |
|---|---|---|
| `DONE` | Отправить промпт | `Делай следующее задание` |
| `FAIL` | Позвать пользователя | `Требуется ваше участие. Откройте чат ChatGPT.` |
| `ERROR` | Отправить промпт | Попытаться исправить ошибку и продолжить |

Legacy-флаг должен находиться в последней непустой строке ответа и совпадать точно, включая регистр.

---

## Roadmap

Разработка идёт по фазам, описанным в [`ROADMAP.md`](ROADMAP.md).

Ближайшие этапы:

- **Phase 0 — Repository reset / Rename hygiene** — новое имя, документация, versioning policy;
- **Phase 1 — Adapter extraction and deterministic core** — отделение DOM automation от orchestration logic;
- **Phase 2 — Service Worker Orchestrator + Tab Registry** — централизованное управление несколькими вкладками;
- **Phase 3 — Orchestra Protocol v1 + Event Bus** — machine-readable events, idempotency и routing;
- **Phase 4+** — Planner/Critic, DAG, scheduler, Git isolation, review, integration и recovery.

Главный принцип разработки: каждая новая фаза должна оставлять систему в проверяемом и восстанавливаемом состоянии, а не наращивать автономность ценой недетерминированности.

---

## Быстрый старт legacy foundation

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
6. Обнови уже открытые вкладки ChatGPT.
7. Открой popup расширения и настрой legacy-флаги.

На текущем этапе сборка, Node.js и установка зависимостей не требуются.

---

## Требования

- Microsoft Edge с поддержкой Manifest V3 extensions;
- Developer mode для установки из исходников;
- доступ к `https://chatgpt.com/` или `https://chat.openai.com/`.

Другие Chromium-браузеры потенциально совместимы, но пока не являются официально протестированной платформой.

---

## Конфигурация legacy runner

| Параметр | Назначение | Значение по умолчанию |
|---|---|---:|
| Обработка флагов | Глобальное включение automation | Включено |
| Базовая задержка | Пауза после завершения генерации | `1200 мс` |
| Случайная добавка | Дополнительная задержка | `0…1200 мс` |
| Правила | Флаг + действие + payload | `DONE`, `FAIL`, `ERROR` |

Фактическая задержка рассчитывается как:

```text
base delay + random value from 0 to configured random window
```

Старые настройки `marker` и `followUp` автоматически мигрируют в текущий формат `rules`.

---

## Безопасность текущего baseline

Legacy foundation намеренно консервативен:

- не перезаписывает непустой composer;
- проверяет стабильность ответа перед обработкой;
- не реагирует на старый завершённый ответ только из-за открытия страницы;
- хранит настройки локально;
- не требует API-ключа или внешнего backend;
- имеет доступ только к доменам ChatGPT, указанным в manifest.

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

Открой DevTools (`F12`) на вкладке ChatGPT и найди сообщения с префиксом:

```text
[ChatGPT Orchestra]
```

Типичные события legacy runner:

```text
Generation detected.
Generation finished. Checking flag after randomized delay.
Flag check scheduled in 1847 ms.
Follow-up sent: Делай следующее задание
User notified for marker: FAIL
```

Текущая реализация всё ещё зависит от DOM ChatGPT и набора fallback selectors. Выделение этой логики в отдельный adapter — задача Phase 1.

---

## Версионирование

Новая multi-agent архитектура развивается как **2.x**.

Для Manifest V3 используется числовое поле:

```json
"version": "2.0.0"
```

А человекочитаемый prerelease хранится в:

```json
"version_name": "2.0.0-alpha.1"
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
- extension зависит от DOM ChatGPT;
- legacy rule обрабатывается только после генерации, наблюдаемой текущей вкладкой;
- duplicate protection пока локален для content script, а не глобален для project event bus;
- отсутствуют scheduler, persisted project state, Git isolation и crash recovery;
- автоматическая обработка флага не доказывает корректность ответа модели.

Эти ограничения являются предметом следующих фаз roadmap, а не скрываются как готовые возможности.

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
