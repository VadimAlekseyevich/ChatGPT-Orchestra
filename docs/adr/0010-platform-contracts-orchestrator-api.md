# 0010 — Platform contracts and Orchestrator API before desktop runtime

Status: Accepted
Date: 2026-09-13

## Context

After alpha.10 Orchestra already has a substantial orchestration engine, but its production composition is a Manifest V3 service worker. Direct dependencies on `chrome.tabs`, `chrome.storage.local`, `chrome.alarms` and Chrome sender objects would make a future Electron/Node runtime a rewrite rather than a port.

The desktop migration roadmap deliberately avoids changing control plane, persistence and ChatGPT automation at the same time.

## Decision

Introduce explicit platform contracts before adding any desktop shell.

### AgentRuntime

Logical agents are addressed by `agentId`; platform sessions are opaque `sessionId` bindings. Browser tab/page APIs live behind an AgentRuntime implementation.

The extension implementation is `ExtensionAgentRuntime`. A deterministic `FakeAgentRuntime` is used in tests. A future Playwright/CDP runtime must satisfy the same contract.

### StateStore

Persistence consumers receive a get/set-compatible StateStore. The extension implementation is `ChromeStorageStateStore`; deterministic tests use `MemoryStateStore`.

Phase 10 preserves existing storage keys/schema for behavior parity. Portable canonical schema and SQLite are Phase 11.

### TimerRuntime

Periodic watchdog scheduling uses a runtime contract. Extension alarms are provided by `ChromeAlarmRuntime`; tests use `DeterministicTimerRuntime`.

### Orchestrator API

UI/admin commands and queries are represented as platform-neutral operations. Existing extension message names remain a compatibility transport mapped onto the API. The future desktop renderer will use the same API through desktop IPC.

### Event sender identity

EventBus authorization uses normalized logical runtime identity (`agentId`, `sessionId`, kind), not Chrome `sender.tab.id` as its canonical identity. Legacy tab ID may remain diagnostic metadata during migration.

## Consequences

Positive:

- existing orchestration behavior remains available in the extension;
- Core/control path can be tested without Chrome globals;
- desktop shell can be added later without changing Scheduler/Review/Integration contracts;
- popup and future desktop renderer can converge on one API;
- browser sender objects are no longer protocol identity.

Costs:

- during transition `TabRegistry` and old persisted agent records still contain `tabId` compatibility data;
- some existing stores retain storage-area-compatible constructor aliases until Phase 11;
- service worker remains extension-specific as the current composition root;
- there are two layers (legacy message transport and Orchestrator API) until UI migration is complete.

## Alternatives considered

### Rewrite directly in Electron

Rejected because it would change runtime lifecycle, storage, browser automation and UI simultaneously and remove the extension as a parity reference.

### Add Playwright first

Rejected. Browser automation is the most brittle migration surface and should be replaced only after control plane and durable state are portable.

### Keep Chrome APIs inside Core and mock them

Rejected. Mocks would hide platform coupling rather than define a stable runtime contract.

## Follow-up

Phase 11 will define portable durable state, migrations, project bundle export/import and SQLiteStateStore. Phase 15+ will consume these contracts from the desktop application.
