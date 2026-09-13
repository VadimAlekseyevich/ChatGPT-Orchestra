# ADR 0015: Desktop shell as a second composition root

- Status: Accepted for Phase 15 implementation
- Date: 2026-09-13

## Context

The orchestration Core is already portable and has explicit AgentRuntime, StateStore, TimerRuntime and Orchestrator API boundaries. Rewriting the Core inside Electron would duplicate policy and create divergence from the extension before the migration is complete.

## Decision

Add a desktop composition root that reuses the existing Core modules unchanged. The main process owns durable SQLite state, watchdog timers, structured local logs and the fake agent runtime. The renderer talks to Core only through the versioned Orchestrator API over a narrow IPC bridge and reuses the shared Dashboard frontend.

Electron and Node values are host implementation details. IPC payloads are JSON-cloned on both sides of the boundary so BrowserWindow, Event, Buffer, process and other runtime handles cannot become Core DTOs.

The extension remains a valid parallel host. Phase 16 may replace FakeAgentRuntime with a companion bridge without changing Scheduler/Review/Integration policy, and Phase 17 may add the real GitWorkspace adapter independently.

## Consequences

- Desktop and extension execute the same orchestration rules.
- SQLite and process-lifetime timers become real desktop infrastructure immediately.
- Dashboard parity is testable without duplicating UI logic.
- Fake executors remain explicit until the companion bridge exists.
- The release line stays on `alpha.15` until the feature PR is green and the phase is release-recorded.
