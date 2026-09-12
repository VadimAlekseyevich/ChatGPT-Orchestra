# Architecture Decision Records

ADR фиксируют важные архитектурные решения ChatGPT Orchestra и причины, по которым выбран конкретный вариант.

## Формат

Рекомендуемый шаблон:

```text
# NNNN — Название

Status: Proposed | Accepted | Superseded | Rejected
Date: YYYY-MM-DD

## Context

## Decision

## Consequences

## Alternatives considered
```

## Правила

- номер ADR не переиспользуется;
- принятое решение не переписывается задним числом без явной пометки;
- новое решение, заменяющее старое, создаётся отдельным ADR и ссылается на superseded ADR;
- ADR должен описывать trade-offs, а не только итоговый выбор.

## Index

- [`0001-versioning-policy.md`](0001-versioning-policy.md) — versioning policy для перехода от legacy baseline к Orchestra 2.x;
- [`0002-orchestra-protocol-v1.md`](0002-orchestra-protocol-v1.md) — versioned `@@ORCH` envelope, persisted event identity и idempotency semantics;
- [`0003-persisted-planning-pipeline.md`](0003-persisted-planning-pipeline.md) — staged persisted planning, separate large artifacts and deterministic DAG readiness gate;
- [`0004-conflict-aware-scheduler.md`](0004-conflict-aware-scheduler.md) — persisted task/run scheduler, conflict-prevention policy and transitional `DONE_UNVERIFIED` semantics;
- [`0005-git-task-isolation.md`](0005-git-task-isolation.md) — per-run task branches, immutable base snapshot and independent Git artifact validation.
