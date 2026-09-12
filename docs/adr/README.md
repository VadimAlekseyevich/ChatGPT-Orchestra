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
- [`0002-orchestra-protocol-v1.md`](0002-orchestra-protocol-v1.md) — versioned `@@ORCH` envelope, persisted event identity и idempotency semantics.
