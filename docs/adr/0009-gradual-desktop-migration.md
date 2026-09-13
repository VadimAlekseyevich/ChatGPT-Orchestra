# 0009 — Gradual migration from browser extension to desktop application

Status: Accepted

Date: 2026-09-13

## Context

After Phase 9, ChatGPT Orchestra already contains substantial platform-independent orchestration behavior: planning, DAG validation, scheduling, review, integration, protocol identity and crash recovery. However, the current composition root and persistence are still strongly tied to Manifest V3 APIs such as `chrome.tabs`, `chrome.storage.local`, `chrome.runtime` and `chrome.alarms`.

A direct rewrite into Electron/Playwright would change the orchestration runtime, persistence model, browser automation and UI at the same time. That would make behavioral regressions difficult to identify and would discard the strongest advantage of the existing implementation: deterministic state machines that have already been hardened phase by phase.

The desired end state is a local desktop application that owns durable project state, local Git workspaces and orchestration, while ChatGPT browser sessions remain replaceable executor nodes.

## Decision

Migrate incrementally through explicit platform contracts rather than rewriting the product.

### 1. Introduce platform-neutral boundaries first

Core modules must depend on contracts such as:

- `AgentRuntime`;
- `StateStore`;
- `TimerRuntime`;
- `GitWorkspace` / `GitProvider`;
- `CommandRunner`;
- `Orchestrator API`.

The Core must not directly import Chrome, Electron, Playwright, DOM or SQLite APIs.

### 2. Preserve the extension as a reference implementation

The existing extension is not removed during migration. Its current browser behavior is wrapped behind extension implementations of the new contracts.

This provides a behavioral baseline while desktop implementations are developed.

### 3. Move the control plane to desktop before replacing browser automation

The first real desktop runtime will run Orchestra Core, SQLite persistence and the shared Dashboard locally, while the extension temporarily becomes a thin companion bridge to existing ChatGPT tabs.

Logical transition:

```text
Desktop Core + SQLite + Dashboard
              │
       authenticated bridge
              │
        Edge extension
              │
         ChatGPT tabs
```

This separates migration of the control plane from migration of ChatGPT automation.

### 4. Replace the extension bridge only after desktop control-plane parity

A later `PlaywrightAgentRuntime` / CDP runtime will manage a dedicated persistent Chromium profile directly from the desktop application.

At that point the extension becomes optional/fallback rather than a required component.

### 5. Move engineering execution local

Desktop adds local Git repositories, per-run worktrees, local diff validation and a bounded `CommandRunner`. Remote GitHub validation remains useful for provenance/push checks but is no longer the only way to validate task artifacts.

### 6. Keep project state portable

Project state must be serializable without browser handles. A portable Project Bundle and schema migrations must support extension → desktop import before the desktop control plane becomes primary.

### 7. Desktop reference stack

The initial reference shell is Electron + Node.js because it maximizes reuse of the JavaScript codebase and supports SQLite, filesystem, Git and browser automation. Electron is not part of the Core contract; a future shell change must not require rewriting orchestration state machines.

Direct desktop ChatGPT automation is expected to use Playwright/CDP with a dedicated persistent browser profile. Orchestra must not extract credentials/cookies from the user's normal browser profile.

## Consequences

### Positive

- No big-bang rewrite.
- Existing extension remains usable throughout migration.
- Core behavior can be compared across runtimes using shared contract tests.
- Desktop can become the source of truth before browser automation is replaced.
- SQLite and local Git/worktrees substantially improve recovery and verification capabilities.
- The same Dashboard and Orchestrator API can serve extension and desktop.
- The architecture naturally supports future executor providers without changing Scheduler/Review/Recovery.

### Costs

- A temporary dual-runtime period must be maintained.
- The companion transport requires secure pairing/authentication.
- Platform contracts and conformance tests add up-front work before visible desktop features.
- Project state migrations must support both Chrome storage and SQLite during transition.
- Extension and direct desktop AgentRuntime behavior must be kept comparable until parity is proven.

## Security consequences

The desktop application gains powers that the extension does not currently have, including filesystem access and local command execution. Therefore desktop migration requires explicit repository trust, bounded command execution, secret redaction, renderer isolation and fail-closed recovery before destructive actions.

The extension ↔ desktop bridge must be authenticated; an unauthenticated localhost control endpoint is not acceptable.

## Alternatives considered

### Rewrite directly in Electron

Rejected because it changes too many dimensions at once and provides no reliable parity baseline.

### Keep the entire orchestrator permanently inside the extension and add a desktop UI only

Rejected because it preserves MV3 lifecycle/storage limitations and does not enable local Git worktrees, SQLite or reliable process supervision.

### Replace ChatGPT tabs with Playwright before moving the Core

Rejected because browser automation regressions would be mixed with state/persistence migration problems.

### Build a cloud orchestration backend first

Rejected. The near-term product goal is a local desktop engineering tool; adding a server would increase privacy, deployment and distributed-state complexity before desktop parity is proven.

## Resulting roadmap

The accepted order is:

```text
Platform Boundary
→ Portable Persistence
→ Portable Dashboard
→ Context Packets
→ Contract Tests / CI
→ Desktop Shell
→ Desktop Control Plane + Extension Companion
→ Local Git Worktrees
→ Direct Desktop ChatGPT Runtime
→ Desktop Parity / Hardening
→ Desktop-first Alpha
```
