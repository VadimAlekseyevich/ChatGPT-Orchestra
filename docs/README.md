# ChatGPT Orchestra Documentation

Этот каталог содержит проектную, архитектурную и release-документацию, которая слишком подробна для корневого `README.md`.

## Текущий release path

- [`alpha-20-validation.md`](alpha-20-validation.md) — канонический runbook desktop-first `2.0.0-alpha.20`: 17 acceptance-сценариев, обязательные ручные A01/A11 checks и signed Windows release gate;
- [`alpha-16-smoke-test.md`](alpha-16-smoke-test.md) — исторический Phase 16 Windows checkpoint; это не финальный alpha gate;
- [`../ROADMAP.md`](../ROADMAP.md) — целевая архитектура и полный browser-extension → desktop roadmap;
- [`../CHANGELOG.md`](../CHANGELOG.md) — история изменений.

Phase 15–20 уже реализованы в коде и regression suites. Для текущего состояния продукта исходной точкой является `alpha-20-validation.md`, а не старые extension-first smoke tests.

## Архитектурные документы

- [`phase-2-tab-registry.md`](phase-2-tab-registry.md) — contract service worker, agent registration, heartbeat и lifecycle вкладок;
- [`phase-3-protocol-v1.md`](phase-3-protocol-v1.md) — Orchestra Protocol v1, Event Bus, idempotency, sequence и rejection semantics;
- [`phase-4-project-planning.md`](phase-4-project-planning.md) — Project Store, staged planning pipeline, large-artifact framing, crash recovery и deterministic DAG gate;
- [`phase-5-scheduler.md`](phase-5-scheduler.md) — persisted task/run state, runnable queue, parallel Worker assignment, conflict policy, retries и watchdog;
- [`phase-5-smoke-test.md`](phase-5-smoke-test.md) — local Node + Edge acceptance checks для scheduler;
- [`phase-6-git-task-isolation.md`](phase-6-git-task-isolation.md) — per-run branches, base snapshot, GitProvider и independent artifact validation;
- [`phase-6-smoke-test.md`](phase-6-smoke-test.md) — local Node + Edge acceptance checks для Git isolation;
- [`phase-7-review-loop.md`](phase-7-review-loop.md) — dynamic independent Reviewer role, structured acceptance checks и bounded rework loop;
- [`phase-7-smoke-test.md`](phase-7-smoke-test.md) — local Node + Edge acceptance checks для independent review;
- [`phase-8-integrator.md`](phase-8-integrator.md) — dynamic Integrator role, deterministic merge composition, remote provenance verification и semantic conflict remediation;
- [`phase-8-smoke-test.md`](phase-8-smoke-test.md) — local Node + Edge acceptance checks для verified integration, text conflicts и semantic conflicts;
- [`phase-9-pause-resume-recovery.md`](phase-9-pause-resume-recovery.md) — recovery control plane, safe-point Pause, Stop Now, Resume и crash reconciliation;
- [`phase-9-smoke-test.md`](phase-9-smoke-test.md) — browser/service-worker crash, Pause/Resume и Stop Now acceptance checks;
- [`phase-10-platform-boundary.md`](phase-10-platform-boundary.md) — AgentRuntime, StateStore, TimerRuntime, Orchestrator API и normalized event sender identity;
- [`phase-10-smoke-test.md`](phase-10-smoke-test.md) — Node/Edge/API acceptance gates для behavior-preserving portability layer;
- [`phase-11-portable-persistence.md`](phase-11-portable-persistence.md) — canonical portable state, migration registry, transactional persistence, Project Bundle и SQLite adapter;
- [`phase-11-smoke-test.md`](phase-11-smoke-test.md) — extension export/import, corruption checks и extension → SQLite migration gate;
- [`phase-12-dashboard-observability.md`](phase-12-dashboard-observability.md) — portable Dashboard, versioned Observability read model, Orchestrator API v3 и safe task controls;
- [`phase-12-smoke-test.md`](phase-12-smoke-test.md) — extension + standalone Fake transport acceptance checks для Dashboard/observability;
- [`phase-13-context-agent-packets.md`](phase-13-context-agent-packets.md) — ContextStore, bounded role packets, context budgets, decision register и fresh-session role bootstrap;
- [`phase-13-smoke-test.md`](phase-13-smoke-test.md) — fresh Lead/Worker/Reviewer/Integrator replacement и portable context acceptance checks;
- [`phase-14-contract-tests-ci.md`](phase-14-contract-tests-ci.md) — reusable adapter conformance, mock browser fixtures, deterministic release validation и GitHub Actions CI foundation;
- [`adr/`](adr/) — Architecture Decision Records.

## Phase 15–20 implementation evidence

Desktop phases are primarily documented by the implementation and executable acceptance suites:

- Phase 15 — `tests/phase15/desktop-synthetic-e2e.test.js` + desktop shell tests;
- Phase 16 — companion bridge/native messaging tests + `alpha-16-smoke-test.md` historical checkpoint;
- Phase 17 — local repository/worktree, verification, integration, lifecycle and salvage tests;
- Phase 18 — managed-browser/direct-runtime tests;
- Phase 19 — parity, chaos/recovery and release-policy tests;
- Phase 20 — `tests/phase20-alpha-scenarios.test.js`, `scripts/alpha-release-contract.js` and `alpha-20-validation.md`.

## Что хранить в `docs/`

По мере реализации roadmap сюда следует выносить:

- architecture overviews;
- protocol specifications;
- state model и persistence schema;
- extension/desktop platform contracts;
- permissions rationale;
- recovery/reconciliation design;
- testing strategy;
- threat/safety model;
- developer setup;
- troubleshooting;
- release process.

## Правило документации

Если решение меняет архитектурный contract, persisted state format, protocol, permissions, safety policy или существенно ограничивает будущие варианты реализации, его нужно фиксировать ADR, а не оставлять только в PR discussion или комментариях к коду.
