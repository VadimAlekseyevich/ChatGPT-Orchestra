<div align="center">

# ChatGPT Orchestra

Multi-agent orchestration for ChatGPT coding workflows, migrating gradually from an Edge extension to a desktop application.

[![Platform](https://img.shields.io/badge/platform-Microsoft%20Edge-0A7EA4?style=for-the-badge)](#requirements-and-permissions)
[![Version](https://img.shields.io/badge/version-2.0.0--alpha.15-orange?style=for-the-badge)](CHANGELOG.md)
[![License](https://img.shields.io/github/license/VadimAlekseyevich/ChatGPT-Orchestra?style=for-the-badge&label=license)](LICENSE)

[Roadmap](ROADMAP.md) · [Changelog](CHANGELOG.md) · [Documentation](docs/README.md)

</div>

---

## What it is

ChatGPT Orchestra coordinates multiple ChatGPT sessions as Lead, Workers, Reviewers and Integrator around a persisted project state.

Core rule: **chats are executors, not the source of truth**. Planning, DAG state, task/run identities, Git provenance, review, integration, recovery, observability and portable role context belong to the Orchestrator Core.

Current prerelease: **`2.0.0-alpha.15`**.

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
Phase 13    bounded portable agent context packets + fresh-session replacement
Phase 14    contract conformance + automated CI release gates
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

`INTEGRATION_VERIFIED` means the integration branch was independently verified. Alpha.15 still does **not** automatically write the target branch.

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
  ContextPacketService
          │
          ▼
   Orchestrator API v4
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
- `GitWorkspace` — repository/workspace lifecycle contract for the future local Git runtime;
- `OrchestratorApi` — platform-neutral command/query surface;
- `ContextPacketService` — bounded persisted role bootstrap independent from one chat transcript.

See [`docs/phase-10-platform-boundary.md`](docs/phase-10-platform-boundary.md), [`docs/phase-13-context-agent-packets.md`](docs/phase-13-context-agent-packets.md) and [`docs/phase-14-contract-tests-ci.md`](docs/phase-14-contract-tests-ci.md).

---

## Portable persistence

Phase 11 introduced a canonical project-scoped snapshot and Project Bundle migration bridge.

Portable state keeps logical identities (`projectId`, `taskId`, `runId`, `agentId`, Git refs/SHAs) but strips browser runtime bindings such as `tabId`, `legacyTabId`, `sessionId` and runtime sender handles.

Phase 13 adds the portable Context namespace to that snapshot: compact Lead summary, decisions register and packet audit metadata survive extension → future desktop import without restoring browser sessions or copying chat transcripts.

Import is allowed only from safe recovery states and always returns to `RECOVERY_REQUIRED` before host-specific reconciliation.

Node desktop groundwork already includes `SQLiteStateStore` with WAL, `BEGIN IMMEDIATE`, rollback and serialized external writes.

See [`docs/phase-11-portable-persistence.md`](docs/phase-11-portable-persistence.md).

---

## Portable Dashboard / Observability API

Phase 12 adds a shared Dashboard frontend that talks only to Orchestrator API. Alpha.15 exposes API v4 while preserving the Phase 12 dashboard contracts.

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

## Portable agent context

Phase 13 makes logical roles replaceable without treating an old ChatGPT conversation as project memory.

`ContextPacketService` builds versioned role packets for:

- Lead planning stages;
- Worker task/rework runs;
- independent Reviewer turns;
- Integrator composition and repair turns.

Packets are assembled from canonical persisted stores, compact completed-task summaries, repository discovery/architecture rules, decisions and Git/artifact references. Runtime bindings and transcript-like fields are recursively excluded.

Each role has a bounded context budget and prompt-contract provenance. Host-side prompt guards fail closed when a v1 packet exceeds its real serialized budget or structurally truncates work-critical task/evidence/merge data: the role must emit `NEEDS_USER` with `context_packet_incomplete` instead of guessing omitted state.

A replacement Lead can continue the same persisted planning stage and `runId`; Worker/Reviewer/Integrator replacement continues through the existing scheduler/review/integration recovery state machines using a newly assembled packet rather than a copied transcript.

Orchestrator API v4 exposes sanitized `contextSummary` and `contextPacket` queries for diagnostics/future desktop use.

See [`docs/phase-13-context-agent-packets.md`](docs/phase-13-context-agent-packets.md), [`docs/phase-13-smoke-test.md`](docs/phase-13-smoke-test.md) and [`docs/adr/0013-portable-agent-context-packets.md`](docs/adr/0013-portable-agent-context-packets.md).

---

## Automated contract and CI gate

Phase 14 makes Core + adapter parity an automated release gate before the desktop runtime exists.

Every pull request and push to `main` runs GitHub Actions for:

- full Core tests on Node 18 and Node 22;
- reusable contract suites on Node 18 and Node 22;
- SQLite/persistence tests on Node 22;
- deterministic extension/browser fixtures on Node 18;
- manifest/package/version/permission validation;
- an aggregate `test:phase14` job that depends on all prerequisite jobs.

Reusable conformance suites now cover `AgentRuntime`, `StateStore`, transactional state, `TimerRuntime`, `GitWorkspace` and Orchestrator API. `FakeGitWorkspace` is the reference test implementation for the local Git/worktree contract that Phase 17 will implement for real.

The first CI rollout found and fixed a real GenerationDetector hydration regression before merge, demonstrating that CI is now an active release gate rather than documentation only.

See [`docs/phase-14-contract-tests-ci.md`](docs/phase-14-contract-tests-ci.md) and [`docs/adr/0014-contract-conformance-ci.md`](docs/adr/0014-contract-conformance-ci.md).

---

## Safety invariants

- dispatch stays closed until recovery reconciliation completes;
- Worker `DONE` is not acceptance;
- mutating results require independently validated Git artifacts;
- authors cannot review their own run;
- dependencies unlock only after `APPROVED`;
- Integrator uses deterministic verified composition;
- target movement fails closed;
- agent roles do not require previous ChatGPT transcript history to resume;
- incomplete/oversized work-critical context packets fail closed to `NEEDS_USER`;
- import never restores live browser handles;
- stale post-import writes are blocked until reload;
- privileged Orchestrator API commands are rejected from agent/browser sessions;
- Dashboard task controls fail closed for active/unsafe states;
- cancelling every task terminates the project as `CANCELLED`, not integration-ready;
- Core + contract CI must be green before a release PR is considered ready;
- target branch writes remain outside alpha.15.

---

## Quick start

```powershell
git clone https://github.com/VadimAlekseyevich/ChatGPT-Orchestra.git
cd ChatGPT-Orchestra
npm test
npm run test:phase14
```

Then load the repository as an unpacked Edge extension, open ChatGPT, explicitly register a Lead, create/plan a project, create Workers and start execution. The popup includes the portable Dashboard alongside bootstrap/legacy controls.

Production ChatGPT DOM behavior still has a manual smoke gate; deterministic fixture coverage is automated in CI.

---

## Requirements and permissions

- Microsoft Edge / Manifest V3 for the current production host;
- ChatGPT access;
- Node.js 18+ for development tests;
- Node 22 for the CI SQLite path.

Manifest permissions remain:

- `storage` — extension persistence;
- `tabs` — extension AgentRuntime;
- `alarms` — extension TimerRuntime;
- ChatGPT hosts — content adapter;
- `https://api.github.com/*` — read-only Git provenance/recovery validation.

Phase 14 adds no new extension permission.

---

## Roadmap

The migration remains incremental rather than a desktop rewrite:

- Phase 10 — Platform Boundary + Orchestrator API — `alpha.11`;
- Phase 11 — Portable Persistence + Project Export/Import — `alpha.12`;
- Phase 12 — Portable Dashboard + Observability API — `alpha.13`;
- Phase 13 — Context Management + Portable Agent Packets — `alpha.14`;
- Phase 14 — Contract Tests + CI Foundation — `alpha.15`;
- **Phase 15 — Desktop Shell Bootstrap — next;**
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
- [`docs/phase-13-context-agent-packets.md`](docs/phase-13-context-agent-packets.md)
- [`docs/phase-14-contract-tests-ci.md`](docs/phase-14-contract-tests-ci.md)
- [`docs/adr/0014-contract-conformance-ci.md`](docs/adr/0014-contract-conformance-ci.md)
