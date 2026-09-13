# Phase 14 — Contract Tests + CI Foundation

Phase 14 makes automated Core and portability checks a required development surface before a second runtime is introduced.

## Goals

- run deterministic Core tests on every PR and push to `main`;
- execute the same adapter conformance semantics against current and future runtime implementations;
- keep Node 18 compatibility while exercising SQLite on Node 22;
- validate Manifest V3 declarations, prerelease version consistency and declared extension files;
- exercise ChatGPT adapter behavior against stable mock-browser fixtures;
- keep production ChatGPT smoke testing as a separate manual release gate.

## Contract suites

Reusable conformance lives under `tests/contracts/` and covers:

- `AgentRuntime`;
- `StateStore` and transactional StateStore behavior;
- `TimerRuntime`;
- `GitWorkspace` (fake/reference contract in Phase 14; local implementation arrives in Phase 17);
- `Orchestrator API` command/query coverage.

`PlatformContracts` is the canonical list of required methods and API names. Contract tests fail when the declaration and implementation surface drift apart.

## Browser fixtures

`tests/fixtures/chatgpt-states.json` contains deterministic mock HTML states for:

- idle;
- generating;
- completed;
- composer occupied;
- error;
- login required;
- navigation changed.

The fixture suite drives the production `ComposerAdapter` against a minimal mock DOM. This is not a replacement for production DOM smoke testing; it protects the adapter's expected state semantics from accidental regressions.

## Release validation

`scripts/validate-release.js` verifies:

- Manifest V3;
- `manifest.version_name === package.version`;
- numeric manifest version prefixes the prerelease version;
- Phase 14 prerelease is `2.0.0-alpha.15`;
- expected extension/host permissions with no duplicates;
- service worker and content-script files exist;
- platform contract version/API context surfaces/GitWorkspace contract are present;
- Phase 14 package scripts and CI workflow exist.

## GitHub Actions

`.github/workflows/ci.yml` runs:

1. full Core suite on Node 18 and Node 22;
2. reusable contract suite on Node 18 and Node 22;
3. persistence/migration/SQLite suite on Node 22;
4. extension browser-fixture suite on Node 18;
5. manifest/release contract on Node 18;
6. aggregate Phase 14 gate on Node 22 after all prior jobs succeed.

The aggregate job depends on all preceding CI jobs, so it cannot be green while a required contract surface is red.

## Safety boundary

Phase 14 does not introduce Electron, desktop IPC, Native Messaging, Playwright/CDP or a production `GitWorkspace`. It only establishes automated parity gates that those later implementations must pass.

## Definition of Done

A PR cannot be considered green unless automated Core and contract checks pass. Production ChatGPT smoke testing remains a separate manual/release gate because the live DOM/provider behavior is external and intentionally not treated as deterministic CI input.
