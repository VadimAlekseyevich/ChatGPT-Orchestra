# 0012 — Portable Dashboard over an Observability Read Model

Status: Accepted
Date: 2026-09-13

## Context

После Phase 10–11 Orchestra Core больше не обязан жить только в MV3 service worker: platform contracts отделяют runtime APIs, а project state можно переносить через portable persistence/SQLite. Следующий риск — снова привязать продукт к extension через UI, который напрямую читает `chrome.storage`, tab handles или внутренние stores.

Dashboard должен стать будущим desktop renderer, поэтому его contract должен быть одинаковым в Edge и в standalone/desktop host.

## Decision

1. Dashboard frontend знает только transport с `query(name,payload)` и `execute(name,payload)`.
2. UI не получает прямого доступа к `chrome.storage`, `chrome.tabs`, SQLite или internal stores.
3. `ObservabilityService` формирует отдельный versioned read model (`observabilityVersion: 1`) поверх project/scheduler/review/integration/recovery/event state.
4. Observability DTO sanitizes browser/session bindings and remains based on logical IDs (`projectId`, `taskId`, `runId`, `reviewId`, `agentId`).
5. `TaskControlService` owns Dashboard mutations; frontend does not rewrite store state.
6. Orchestrator API v3 becomes the stable control/observability surface for Dashboard hosts.
7. Extension host uses a thin `chrome.runtime` transport adapter.
8. Standalone Fake host uses the same `DashboardApp` with a Fake Orchestrator API transport.
9. Open-executor behavior is expressed as logical `openExecutor(agentId)`; host decides how to focus/activate the executor.
10. Alpha.13 may use polling. Subscription/push transport is a future host optimization and must not change Dashboard DTO/command semantics.

## Consequences

### Positive

- Dashboard frontend can be reused as desktop renderer;
- browser handles cannot accidentally become UI/domain identity;
- UI changes do not require persistence schema access;
- observability DTO can evolve independently from internal store schemas;
- debug bundle becomes portable and sanitized;
- standalone Fake host gives a browser-free parity harness before Electron exists.

### Costs

- some data is projected/copied into read-model DTOs;
- polling duplicates occasional API reads in alpha.13;
- mutations need explicit safe Core commands instead of simple store edits;
- Orchestrator API version must be managed as a real product contract.

## Safety rules

- raw chat transcripts are not part of Dashboard DTO;
- runtime/tab/session IDs are stripped from observability and debug output;
- active work is not cancelled by status rewrite;
- Retry/Cancel/Reassign/Review/Integration commands use existing lifecycle engines and fail closed when task/recovery state is incompatible;
- agent sessions cannot issue privileged Dashboard commands.

## Alternatives considered

### Let popup read stores directly

Rejected: would make extension UI impossible to reuse on desktop and couple UI to persistence migrations.

### Build a separate desktop Dashboard later

Rejected: duplicates UI logic and delays portability validation until after desktop shell work.

### Expose raw stores through API

Rejected: store schemas are implementation details and include host/runtime compatibility metadata unsuitable for a stable UI contract.

### Make Dashboard React/Electron-specific now

Rejected: Phase 12 is a portability/API phase, not the desktop-shell phase. A dependency-free DOM frontend is sufficient to validate the shared contract.
