# ChatGPT Orchestra Documentation

Этот каталог предназначен для проектной и архитектурной документации, которая слишком подробна для корневого `README.md`.

## Основные документы

- [`../ROADMAP.md`](../ROADMAP.md) — целевая архитектура, фазы реализации, state machines, scheduler, protocol, Git/review/integration и recovery;
- [`../CHANGELOG.md`](../CHANGELOG.md) — история изменений;
- [`phase-2-tab-registry.md`](phase-2-tab-registry.md) — контракт service worker, agent registration, heartbeat и lifecycle вкладок;
- [`phase-3-protocol-v1.md`](phase-3-protocol-v1.md) — Orchestra Protocol v1, Event Bus, idempotency, sequence и rejection semantics;
- [`phase-4-project-planning.md`](phase-4-project-planning.md) — Project Store, staged planning pipeline, large-artifact framing, crash recovery и deterministic DAG gate;
- [`adr/`](adr/) — Architecture Decision Records.

## Что хранить в `docs/`

По мере реализации roadmap сюда следует выносить:

- architecture overviews;
- protocol specifications;
- state model и persistence schema;
- extension permissions rationale;
- recovery/reconciliation design;
- testing strategy;
- threat/safety model;
- developer setup;
- troubleshooting;
- release process.

## Правило документации

Если решение меняет архитектурный контракт, формат persisted state, protocol, permissions, safety policy или существенно ограничивает будущие варианты реализации — его нужно фиксировать ADR, а не оставлять только в PR discussion или комментариях к коду.
