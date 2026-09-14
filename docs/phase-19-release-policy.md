# Phase 19 Desktop Reliability and Security Policy

Phase 19 promotes the direct managed-browser runtime to the default desktop product path and defines bounded failure behavior before the Desktop-first Alpha release gate.

## Runtime policy

- `electron .` starts the direct managed-browser runtime.
- `--companion` remains an explicit extension-backed fallback.
- `--desktop-shell` is an explicit development/test-only fake-runtime shell.
- Ambiguous multi-runtime selections fail closed.
- One Lead plus up to four Worker slots is the release concurrency ceiling.

## Reliability budgets

The release gate locks the current bounded defaults:

- task retries: 2;
- review iterations: 3;
- integration repair attempts: 2;
- scheduler run timeout: 20 minutes by default;
- local verification command timeout: 10 minutes maximum;
- local verification output: 256 KiB maximum per stream;
- integration target policy: integration branch only;
- direct browser logical agents: at most five total (Lead + four Workers).

A budget exhaustion must become an explicit failure / user-intervention state. It must not silently retry forever or mutate the target branch.

## Stop and recovery boundary

Stop Now has priority over scheduling and completion handling. Late planning, Worker, Review, and Integration events are ignored while the persisted stop boundary is active. Active local verification subprocesses must be cancellable by run ID. Crash recovery reconciles durable state before reopening dispatch.

## Security boundary

- local repository execution defaults to `UNTRUSTED`;
- repository-defined commands require explicit trust and execute with `shell:false` inside Orchestra-owned workspaces;
- command output is bounded and known secret patterns are redacted;
- renderer Node integration stays disabled with context isolation, sandboxing, navigation guards and CSP;
- companion transport remains mutually authenticated;
- destructive Git operations require explicit validated/force policy inputs;
- portable project state must not contain browser credentials, browser-profile paths or platform handles.

## Update and signing policy

The alpha line has no automatic updater. Updates are manual artifact installs and therefore cannot create an unattended executable replacement side effect. CI artifacts are integrity-addressed by GitHub Actions digest.

Publisher code signing is a release-distribution requirement when signing credentials are configured; it is not emulated with repository secrets or a generated local certificate. A future automatic update mechanism must verify publisher identity/signature before it may replace the desktop executable.

## Phase 19 release threshold

The Phase 19 test gate combines direct-runtime parity, duplicate-event idempotency, Pause/Stop guards, restart/recovery, SQLite migration, local worktree recovery, integration repair/conflict coverage, project-bundle privacy checks and this release-policy regression. Unknown or unreconciled state must remain fail-closed and must not trigger target-branch mutation.
