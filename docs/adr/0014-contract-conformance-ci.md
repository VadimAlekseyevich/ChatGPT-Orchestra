# 0014 — Contract Conformance Before Additional Runtimes

Status: Accepted  
Date: 2026-09-13

## Context

The Orchestra Core now has platform-neutral contracts, portable persistence, a shared Dashboard and portable role context. The next roadmap step after Phase 14 introduces a real desktop process. Without automated parity checks, a second runtime could satisfy method names while subtly diverging in semantics.

The repository also previously lacked GitHub Actions, so release confidence depended on local environments and manual smoke testing.

## Decision

Before adding the desktop runtime, ChatGPT Orchestra will require automated Core and contract conformance in CI.

The same reusable conformance semantics apply to current fakes/adapters and future implementations of:

- `AgentRuntime`;
- `StateStore`;
- `TimerRuntime`;
- `GitWorkspace`;
- `Orchestrator API`.

`PlatformContracts` is the declared portability surface. CI checks that declared API command/query names are recognized by `OrchestratorApi` and that adapters satisfy behavioral conformance, not just method presence.

GitHub Actions runs Node 18 and Node 22. Node 18 protects the existing development floor. Node 22 additionally exercises `node:sqlite` persistence behavior.

Mock ChatGPT HTML fixtures are deterministic CI inputs. The live ChatGPT DOM remains an external manual release smoke gate rather than a brittle CI dependency.

## Consequences

Positive:

- desktop adapters cannot be merged merely because they compile;
- API/contract drift is caught before runtime migration;
- SQLite and migration paths receive an automated environment;
- manifest/version mistakes become deterministic failures;
- future Phase 15+ PRs inherit an objective parity baseline.

Trade-offs:

- CI runtime increases as Core suites run across multiple Node versions;
- fixtures must be maintained when the production adapter contract intentionally changes;
- live ChatGPT behavior still needs manual or later browser-E2E validation.

## Safety invariants

- no production secret is required by CI;
- CI has read-only repository contents permission;
- live ChatGPT login/session state is never uploaded to Actions;
- production GitHub credentials are not stored in test fixtures;
- Phase 14 introduces only a fake/reference `GitWorkspace`; local Git writes remain Phase 17.

## Alternatives considered

### Wait until the desktop runtime exists

Rejected. Contract tests added after a second implementation cannot distinguish original semantics from accidental divergence as reliably.

### Run only the full `npm test`

Rejected. Named conformance, persistence, browser-fixture and release jobs make portability failures attributable and provide explicit merge gates.

### Run live ChatGPT E2E in CI

Rejected for this phase. It would require provider credentials/session state and would be non-deterministic relative to the Core contracts Phase 14 is intended to protect.
