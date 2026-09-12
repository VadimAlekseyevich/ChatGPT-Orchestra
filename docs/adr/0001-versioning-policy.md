# 0001 — Versioning policy for the Orchestra architecture line

Status: Accepted  
Date: 2026-09-12

## Context

Репозиторий вырос из single-tab расширения, которое автоматически обрабатывало response flags (`DONE`, `FAIL`, `ERROR`). После переименования в ChatGPT Orchestra целевой продукт существенно меняется: появляется multi-agent orchestration, центральный state store, service worker, event protocol, scheduler, Git isolation, review/integration и recovery.

Продолжать увеличивать старую `1.2.x` как обычный patch/minor означало бы создать ложное впечатление, что новая архитектура — небольшое продолжение старой функции.

При этом Chrome/Edge Manifest V3 требует числовой формат поля `version` и не принимает SemVer prerelease suffix вроде `2.0.0-alpha.1` непосредственно в этом поле.

## Decision

Новая архитектурная линия начинается с **2.x**.

До первого стабильного релиза используются alpha/beta имена в `manifest.version_name`, например:

```json
{
  "version": "2.0.0",
  "version_name": "2.0.0-alpha.1"
}
```

Правила:

1. `version` всегда остаётся валидной числовой MV3-версией.
2. `version_name` показывает пользователю реальную prerelease-стадию.
3. `CHANGELOG.md` использует человекочитаемую версию (`2.0.0-alpha.1`).
4. Legacy `1.x` считается baseline/foundation, а не активной продуктовой линией Orchestra.
5. Пока не выполнен alpha release gate из roadmap, версия не должна называться stable `2.0.0` в пользовательской документации.
6. Breaking changes persisted state/protocol до stable допускаются, но должны сопровождаться migration/reset policy и записью в changelog.

## Consequences

Плюсы:

- пользователю ясно, что это новая архитектурная линия;
- MV3 manifest остаётся валидным;
- prerelease maturity видна в UI/docs;
- changelog может честно отделить legacy baseline от Orchestra.

Минусы:

- числовое `manifest.version` выглядит как stable `2.0.0`, если интерфейс браузера не показывает `version_name`;
- дальнейшие alpha increment требуют дисциплины синхронизации manifest и changelog;
- до stable возможны migration changes, которые нужно документировать особенно аккуратно.

## Alternatives considered

### Продолжить с `1.3.0`

Отклонено: изменение продуктовой и системной архитектуры слишком велико для обычного minor continuation.

### Начать с `0.2.0`

Допустимо технически, но хуже отражает происхождение от уже существующего `1.x` расширения и выглядит как уменьшение версии.

### Использовать `2.0.0-alpha.1` прямо в `version`

Отклонено: несовместимо с форматом version в Chromium Manifest V3.
