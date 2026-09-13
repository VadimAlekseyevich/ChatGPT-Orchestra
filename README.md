<div align="center">

# ChatGPT Orchestra

Multi-agent orchestration for ChatGPT coding workflows, migrating gradually from an Edge extension to a desktop application.

[![Platform](https://img.shields.io/badge/platform-Microsoft%20Edge-0A7EA4?style=for-the-badge)](#requirements-and-permissions)
[![Version](https://img.shields.io/badge/version-2.0.0--alpha.13-orange?style=for-the-badge)](CHANGELOG.md)
[![License](https://img.shields.io/github/license/VadimAlekseyevich/ChatGPT-Orchestra?style=for-the-badge&label=license)](LICENSE)

[Roadmap](ROADMAP.md) · [Changelog](CHANGELOG.md) · [Documentation](docs/README.md)

</div>

---

## What it is

ChatGPT Orchestra coordinates multiple ChatGPT sessions as Lead, Workers, Reviewers and Integrator around a persisted project state.

Core rule: **chats are executors, not the source of truth**. Planning, DAG state, task/run identities, Git provenance, review, integration, recovery and observability belong to the Orchestrator Core.

Current prerelease: **`2.0.0-alpha.13`**.

Completed foundation:

```text
Phase 0–4   repository reset, deterministic adapter, protocol, planning/DAG
Phase 5     conflict-aware parallel scheduler
Phase 6     per-run Git isolation + independent artifact validation
Phase 7     independent review + bounded rework
Phase 8     verified integration branch + semantic conflict remediation
Phase 9     Pause / Stop Now / Resume / crash recovery
Phase 10    platform boundary + Orchestrator API
Phase 11    portable persistence + Project Bundle + SQLiteStateStore
Phase 12    portable Dashboard + Observability API
```

---

## Current execution pipeline

```text
Goal + repository
      ↓
Planning / Critic / DAG validation
      ↓
parallel Workers
      ↓
Git artifact validation
      ↓
independent Review
   ↙             ↘
rework          APPROVED
   └──────┬──────┘
          ↓
READY_FOR_INTEGRATION
          ↓
dynamic Integrator
          ↓
text / semantic conflict remediation
          ↓
INTEGRATION_VERIFIED
```

`INTEGRATION_VERIFIED` means the integration branch was independently verified. Alpha.13 still does **not** automatically write the target branch.

---

## Portable architecture

The extension is now one host for a platform-neutral control plane:

```text
Extension host
  ExtensionAgentRuntime
  ChromeStorageStateStore
  ChromeAlarmRuntime
          │
          ▼
      Orchestra Core
  Planning / Scheduler
  Review / Integration
  Recovery / EventBus
          │
          ▼
   Orchestrator API v3
          │
   ┌──────┴────────┐
   │               │
Edge Dashboard   Fake standalone Dashboard
                   ↓
             future desktop renderer
```

Primary contracts:

- `AgentRuntime` — logical executor/session lifecycle;
- `StateStore` — portable persistence backend;
- `TimerRuntime` — recurring scheduling/watchdogs;
- `OrchestratorApi` — platform-neutral command/query surface.

See [`docs/phase-10-platform-boundary.md`](docs/phase-10-platform-boundary.md).

---

## Portable persistence

Phase 11 introduced a canonical project-scoped snapshot and Project Bundle migration bridge.

Portable state keeps logical identities (`projectId`, `taskId`, `runId`, `agentId`, Git refs/SHAs) but strips browser runtime bindings such as `tabId`, `legacyTabId`, `sessionId` and runtime sender handles.

Import is allowed only from safe recovery states and always returns to `RECOVERY_REQUIRED` before host-specific reconciliation.

Node desktop groundwork already includes `SQLiteStateStore` with WAL, `BEGIN IMMEDIATE`, rollback and serialized external writes.

See [`docs/phase-11-portable-persistence.md`](docs/phase-11-portable-persistence.md).

---

## Portable Dashboard / Observability API

Phase 12 adds a shared Dashboard frontend that talks only to Orchestrator API v3.

The Dashboard can display:

- project/repository/base status;
- DAG and task states;
- active runs and Git artifacts;
- review evidence;
- integration evidence and repairs;
- agent health;
- recovery lifecycle;
- scheduler decisions;
- event/rejection timeline;
- warnings / `NEEDS_USER`;
- local metrics and persistence backend.

Safe control surfaces include Pause/Resume/Stop Now, Retry, Cancel with explicit downstream cascade, Priority, Reassign, Review request, Integration start, executor activation and project/debug export.

The Dashboard has no direct access to `chrome.storage`, `chrome.tabs`, SQLite or internal Scheduler/Review/Integration stores. `dashboard/standalone.html` runs the **same `DashboardApp`** against a Fake transport without Chrome runtime, making it the prototype for the future desktop renderer.

Observability DTOs are bounded/versioned and recursively strip runtime tab/session bindings before reaching UI/debug output.

See [`docs/phase-12-dashboard-observability.md`](docs/phase-12-dashboard-observability.md) and [`docs/adr/0012-portable-dashboard-observability.md`](docs/adr/0012-portable-dashboard-observability.md).

---

## Safety invariants

- dispatch stays closed until recovery reconciliation completes;
- Worker `DONE` is not acceptance;
- mutating results require independently validated Git artifacts;
- authors cannot review their own run;
- dependencies unlock only after `APPROVED`;
- Integrator uses deterministic verified composition;
- target movement fails closed;
- import never restores live browser handles;
- stale post-import writes are blocked until reload;
- privileged Orchestrator API commands are rejected from agent/browser sessions;
- Dashboard task controls fail closed for active/unsafe states;
- cancelling every task terminates the project as `CANCELLED`, not integration-ready;
- target branch writes remain outside alpha.13.

---

## Quick start

```powershell
git clone https://github.com/VadimAlekseyevich/ChatGPT-Orchestra.git
cd ChatGPT-Orchestra
npm test
npm run test:phase12
```

Then load the repository as an unpacked Edge extension, open ChatGPT, explicitly register a Lead, create/plan a project, create Workers and start execution. The popup now includes the portable Dashboard alongside the existing bootstrap/legacy controls.

For acceptance steps see [`docs/phase-12-smoke-test.md`](docs/phase-12-smoke-test.md).

---

## Requirements and permissions

- Microsoft Edge / Manifest V3 for the current production host;
- ChatGPT access;
- Node.js 18+ for development tests;
- Node with `node:sqlite` for SQLite-specific adapter tests.

Manifest permissions remain:

- `storage` — extension persistence;
- `tabs` — extension AgentRuntime;
- `alarms` — extension TimerRuntime;
- ChatGPT hosts — content adapter;
- `https://api.github.com/*` — read-only Git provenance/recovery validation.

Phase 12 adds no new extension permission.

---

## Roadmap

The migration remains incremental rather than a desktop rewrite:

- Phase 10 — Platform Boundary + Orchestrator API — `alpha.11`;
- Phase 11 — Portable Persistence + Project Export/Import — `alpha.12`;
- Phase 12 — Portable Dashboard + Observability API — `alpha.13`;
- **Phase 13 — Context Management + Portable Agent Packets — next;**
- Phase 14 — Contract Tests + CI Foundation;
- Phase 15 — Desktop Shell Bootstrap;
- Phase 16 — Desktop Control Plane + Extension Companion Bridge;
- Phase 17 — Local Repository Runtime + Git Worktrees;
- Phase 18 — Direct Desktop ChatGPT AgentRuntime;
- Phase 19 — Desktop Parity + Reliability/Security Hardening;
- Phase 20 — Desktop-first Alpha;
- Phase 21 — Post-alpha Cutover / Provider Expansion.

Full plan: [`ROADMAP.md`](ROADMAP.md).

---

## Documentation

- [`docs/README.md`](docs/README.md)
- [`docs/phase-10-platform-boundary.md`](docs/phase-10-platform-boundary.md)
- [`docs/phase-11-portable-persistence.md`](docs/phase-11-portable-persistence.md)
- [`docs/phase-12-dashboard-observability.md`](docs/phase-12-dashboard-observability.md)
- [`docs/phase-12-smoke-test.md`](docs/phase-12-smoke-test.md)
- [`docs/adr/0012-portable-dashboard-observability.md`](docs/adr/0012-portable-dashboard-observability.md)
