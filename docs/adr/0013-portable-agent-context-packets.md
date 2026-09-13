# 0013 — Portable Agent Context Packets

Status: Accepted  
Date: 2026-09-13

## Context

The browser extension historically benefited from long-lived ChatGPT tabs. Even after moving project/task/review/integration state into the Orchestrator Core, prompt quality could still implicitly improve because an executor retained earlier conversation history.

That is incompatible with the desktop migration goal. A desktop runtime, recovered browser, replaced tab or alternate provider must be able to create a fresh executor without recreating the full old model transcript.

Raw transcript persistence is also the wrong architectural boundary: it is large, provider-specific, difficult to bound, may contain irrelevant/sensitive text, and makes deterministic recovery harder.

## Decision

ChatGPT Orchestra will treat persisted domain state plus versioned **Context Packets** as the complete bootstrap contract for logical agent roles.

A project-scoped `ContextStore` persists:

- a compact Lead summary artifact;
- a bounded decisions register;
- packet-generation audit metadata.

`ContextPacketService` deterministically builds bounded packets for Lead, Worker, Reviewer and Integrator roles from Project/Scheduler/Review/Integration/Recovery stores and Git/planning artifacts.

Packets:

- have a version and logical-role identity;
- include prompt-contract provenance;
- include compact completed-task summaries;
- use artifact references/evidence instead of copying old chat transcripts;
- carry bounded repository context selected from Discovery/Plan artifacts;
- exclude browser/session/runtime identifiers;
- exclude transcript/history/raw-response fields;
- apply an explicit role-specific context-budget policy.

Planning adds an explicit fresh-Lead replacement path. It reuses the same persisted planning stage and run identity and sends a new self-contained packet to the replacement Lead. Worker, Reviewer and Integrator replacements continue to use their existing retry/requeue/recovery state machines; their prompt contracts now rebuild packets for each physical executor assignment.

`ContextStore` is included as an additive optional namespace in Portable State v1 so existing alpha.13 bundles remain import-compatible.

## Consequences

Positive:

- logical roles no longer require a particular browser tab or old ChatGPT conversation;
- recovery and desktop migration use the same persisted bootstrap mechanism;
- context growth is bounded and auditable;
- prompt version and packet version are independently visible;
- role replacement becomes testable without replaying provider transcripts;
- provider-specific chat history is not promoted to canonical project state.

Trade-offs:

- compact packets can contain less incidental context than a very long human-curated conversation;
- packet schema/budget evolution becomes an explicit compatibility concern;
- repository discovery/planning artifacts must remain sufficiently structured because they now feed fresh executors;
- large evidence sets may require stronger artifact retrieval strategies in later phases rather than increasing prompt size indefinitely.

## Safety invariants

- packets never make runtime/browser identity canonical;
- packet generation must not weaken Git/review/integration validation;
- a replacement Lead must not silently create a second planning run;
- old accepted protocol events remain authoritative through EventBus idempotency, not chat transcript recollection;
- import still requires `RECOVERY_REQUIRED` reconciliation before dispatch;
- agent sessions cannot use privileged Orchestrator API context queries/actions.

## Alternatives considered

### Persist full ChatGPT transcripts

Rejected. Provider-specific, unbounded, privacy-sensitive and unnecessary for canonical orchestration state.

### Keep one permanent Lead conversation forever

Rejected. Browser/session continuity would remain a hidden single point of failure and block desktop portability.

### Summarize only when a tab is lost

Rejected. Recovery-time summarization would require the very old session that may already be unavailable. Context must be reconstructible continuously from persisted state.

### Put every repository artifact into every prompt

Rejected. It recreates unbounded context growth and hides relevance selection. Packets instead use bounded repository context plus artifact references/evidence appropriate to each role.
