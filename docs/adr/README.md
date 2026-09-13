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
- [`0005-git-task-isolation.md`](0005-git-task-isolation.md) — per-run task branches, immutable base snapshot and independent Git artifact validation;
- [`0006-independent-review-loop.md`](0006-independent-review-loop.md) — dynamic Reviewer role, author/reviewer separation, structured approval and bounded rework loop;
- [`0007-verified-integration-branches.md`](0007-verified-integration-branches.md) — dynamic Integrator role, deterministic `--no-ff` composition, independently verified integration branches and bounded semantic conflict remediation;
- [`0008-recovery-control-plane.md`](0008-recovery-control-plane.md) — separate persisted lifecycle control plane, safe-point Pause, Stop Now boundary and reconcile-before-resume policy;
- [`0009-gradual-desktop-migration.md`](0009-gradual-desktop-migration.md) — platform contracts, desktop control-plane migration, extension companion bridge and eventual direct desktop AgentRuntime;
- [`0010-platform-contracts-orchestrator-api.md`](0010-platform-contracts-orchestrator-api.md) — AgentRuntime/StateStore/TimerRuntime boundaries, normalized runtime identity and platform-neutral Orchestrator API;
- [`0011-portable-persistence-project-bundles.md`](0011-portable-persistence-project-bundles.md) — project-scoped portable state, migration registry, Project Bundle, import recovery gate and SQLite persistence;
- [`0012-portable-dashboard-observability.md`](0012-portable-dashboard-observability.md) — shared Dashboard frontend over a versioned sanitized Observability read model and Orchestrator API v3;
- [`0013-portable-agent-context-packets.md`](0013-portable-agent-context-packets.md) — persisted compact context, versioned bounded role packets and fresh-session bootstrap without transcript dependency.
