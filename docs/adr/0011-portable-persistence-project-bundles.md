# ADR 0011 — Portable persistence and Project Bundles

- Status: Accepted
- Date: 2026-09-13
- Decision owners: ChatGPT Orchestra maintainers

## Context

Alpha.11 introduced platform contracts and a portable Orchestrator API, but durable state was still operationally tied to the extension's `chrome.storage.local` records and included extension runtime metadata such as tab/session bindings.

The desktop migration requires the same logical project to survive a backend change from Chrome storage to SQLite without treating browser handles as source of truth.

## Decision

### 1. Portable state is project-scoped and versioned

Introduce `PortableState` schema v1 over the existing logical stores:

```text
projects
scheduler
reviews
integration
recovery
events
agents
```

Only one selected project is included in a portable snapshot.

### 2. Browser session identity is not canonical durable state

Portable snapshots exclude runtime bindings such as `tabId`, `legacyTabId`, `sessionId` and EventBus runtime sender provenance.

Historical logical `agentId` values may remain in run/review/event provenance, but import never interprets them as a live browser session.

The imported live agent registry is empty.

### 3. Import always closes the dispatch gate

Regardless of the source recovery status, imported state becomes:

```text
RECOVERY_REQUIRED
```

with reason `portable_import_reconciliation_required`.

Host-specific reconciliation is required before dispatch resumes.

### 4. Schema migrations are explicit and sequential

Portable migrations use a registry of one-version transitions. Missing migration paths and schemas from the future fail closed.

### 5. Every import creates a backup

Before writing imported state, the destination captures the current Orchestra storage namespaces into a bounded backup history.

### 6. Project Bundle v1 is a bounded JSON migration artifact

The first bundle format is a single JSON file with manifest, project, canonical state and debug projections for events/decisions.

Exports redact known credential fields and token-shaped values.

A deterministic checksum detects accidental modification. It is not a cryptographic signature and does not establish authenticity.

### 7. StateStore gains transactional semantics

Portable import requires `get/set/remove/clear/transaction`.

The extension uses a serialized transaction wrapper around Chrome storage. SQLite uses native `BEGIN IMMEDIATE / COMMIT / ROLLBACK` transactions.

Chrome storage is not promoted to database-level ACID semantics; the backup + recovery gate remain required.

### 8. SQLite is the first desktop persistence adapter

`SQLiteStateStore` uses Node's `node:sqlite` API and WAL mode when supported.

The extension runtime does not load or depend on this Node-only module.

## Consequences

### Positive

- extension state can be exported before Electron exists;
- desktop persistence can be tested independently of browser automation;
- browser tab IDs cease to be necessary for project migration;
- schema changes now have an explicit fail-closed migration mechanism;
- import cannot silently resume stale execution;
- future Dashboard/debug export can reuse Project Bundle primitives.

### Costs

- bundle v1 duplicates some event/decision data for observability;
- Chrome transaction semantics remain serialized best-effort rather than crash-atomic;
- imported extension state requires a runtime reload before reconciliation;
- SQLite requires a modern Node runtime for its native adapter.

## Rejected alternatives

### Copy raw `chrome.storage.local` to desktop

Rejected because it preserves browser-specific schema and runtime identities as accidental API contracts.

### Make `tabId` portable

Rejected because tab IDs have no stable meaning outside one browser runtime.

### Resume automatically after import

Rejected because imported executor sessions and Git/runtime environment have not yet been reconciled.

### Delay export/import until Electron exists

Rejected because migration should be testable before the desktop shell and because Project Bundle provides the bridge needed to validate that separation early.

## Follow-up

Phase 12 must consume state only through Orchestrator API/portable observability DTOs, not by reading Chrome storage or SQLite directly.
