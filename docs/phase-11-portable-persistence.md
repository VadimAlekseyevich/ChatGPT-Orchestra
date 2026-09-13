# Phase 11 — Portable Persistence + Project Export/Import

Phase 11 turns the alpha.11 platform boundary into a migration bridge between the Edge extension and the future desktop control plane.

## Goals

The same logical project must be serializable without browser handles and loadable through a different persistence backend.

The canonical portable unit is a single project. Runtime sessions are deliberately excluded.

```text
Edge extension state
        ↓
PortableState schema v1
        ↓
Project Bundle v1
        ↓
validation + migration
        ↓
SQLiteStateStore / another StateStore
        ↓
RECOVERY_REQUIRED
        ↓
host-specific reconciliation
```

## Portable namespaces

Portable state schema v1 maps the existing persisted stores into stable logical namespaces:

```text
projects
scheduler
reviews
integration
recovery
events
agents
```

The implementation reads the current storage keys through the shared `StateStore` abstraction, not through `chrome.storage` directly.

Only the selected project is exported. Historical projects and events from another explicit `projectId` are not part of the project bundle.

## Runtime identities are not portable state

A bundle does not require or restore:

```text
tabId
legacyTabId
sessionId
EventBus runtimeSource
ChatGPT tab bindings
```

The imported agent registry starts empty. Historical `agentId` references inside task/run/review/event provenance remain valid logical identifiers, but they do not imply a live executor session.

Recovery snapshots and EventBus provenance are recursively stripped of extension session bindings.

## Secret redaction

Export applies deterministic redaction before bundle construction.

Known credential-shaped keys such as `password`, `accessToken`, `refreshToken`, `apiKey`, `authorization`, cookies, private keys and credentials are replaced with `[REDACTED]`.

Common standalone token values such as GitHub tokens, OpenAI-style `sk-...` values, bearer credentials and PEM private keys are also redacted.

The project bundle is not intended to be a credential backup.

## Project Bundle v1

The first portable representation is a bounded JSON file:

```text
chatgpt-orchestra-<projectId>.bundle.json
```

Logical contents:

```text
format
bundleVersion
schemaVersion
manifest
project
state
events
decisions
artifacts
```

`state` is the canonical source used for import. `events` and `decisions` are duplicated as human/debug-friendly projections.

The bundle is limited to 8 MiB in alpha.12 and carries a deterministic FNV-1a 64-bit checksum. The checksum is an accidental-corruption/tampering detector, not a cryptographic signature.

Import fails closed on:

- invalid JSON;
- wrong bundle format/version;
- project identity mismatch;
- checksum mismatch;
- unsupported future schema;
- missing migration path;
- a different existing active project unless explicit replacement is requested.

## Migration registry

`MigrationRegistry` accepts only ordered one-version steps:

```text
v1 → v2 → v3
```

Skipping a version or importing a schema from the future fails closed. Alpha.12 starts at portable schema v1, so there is no historical portable migration to run yet; the registry exists before schema v2 is introduced.

## Backups

Every import creates a pre-import backup of all Orchestra domain storage keys in:

```text
orchestra.portable.backups.v1
```

The extension retains the most recent three backups by default.

Backups are taken inside the same transaction boundary as the import operation.

## StateStore transaction semantics

Phase 11 adds a stronger transactional StateStore contract:

```text
get
set
remove
clear
transaction
```

### Extension

`TransactionalStateStore` wraps `ChromeStorageStateStore` and serializes all writes through one chain. Transaction callbacks operate on an isolated overlay and commit their staged values together.

Chrome storage does not provide database-level crash-atomic transactions, so the automatic pre-import backup and `RECOVERY_REQUIRED` gate remain part of the safety model.

### SQLite

`SQLiteStateStore` is a Node adapter backed by `node:sqlite`.

It enables WAL mode when supported, stores key/value snapshots in `orchestra_kv`, records adapter metadata in `orchestra_meta`, and uses real `BEGIN IMMEDIATE / COMMIT / ROLLBACK` semantics.

`node:sqlite` is available in modern Node releases. Core/extension tests remain compatible with older Node versions; SQLite-specific tests skip when that module is unavailable.

## Import safety

Import never resumes work automatically.

The imported recovery namespace is rewritten to:

```text
status = RECOVERY_REQUIRED
reason = portable_import_reconciliation_required
```

and the live agent registry is empty.

For the Edge extension, `OrchestratorApi` accepts import only when recovery is already in one of:

```text
IDLE
PAUSED
STOPPED
RECOVERY_REQUIRED
```

After a successful extension import, `reloadRequired=true`. The popup reloads the extension so all in-memory stores are recreated from the imported snapshot before any reconciliation or dispatch.

While that reload is pending, the service worker ignores new tab/runtime/watchdog work.

A desktop host can import into an unopened SQLite store before constructing Orchestra Core.

## Orchestrator API v2

Phase 11 adds:

Commands:

```text
exportProjectBundle
importProjectBundle
```

Query:

```text
persistence
```

The existing popup message names are still only a transport compatibility layer over this API.

## Popup flow

The extension popup now contains `Portable Project Bundle` controls.

Export downloads the bounded `.bundle.json` file.

Import reads a local JSON bundle, sends it to the service worker for validation/migration, then reloads the extension after a successful commit.

## Testing

`npm run test:phase11` covers:

- StateStore conformance;
- SQLite transaction rollback;
- migration registry behavior;
- project-scoped portable capture;
- runtime identity stripping;
- secret redaction;
- pre-import backup;
- recovery gating;
- bundle checksum validation;
- extension-shaped state → SQLite round-trip;
- Orchestrator API import safety.

## Phase boundary

Phase 11 does not create Electron, a desktop UI, Playwright automation or local Git worktrees.

The next phase builds a portable Dashboard/Observability surface on top of the Orchestrator API and the persistence boundary established here.
