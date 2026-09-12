# 0005 — Per-run Git isolation and independent artifact validation

Status: Accepted
Date: 2026-09-12

## Context

Phase 5 can schedule multiple ChatGPT Workers concurrently, but a Worker `DONE` is only a claim. Without an isolated branch and independently checked commit, Orchestra cannot prove which code belongs to a run, whether the Worker touched files outside task scope, or whether the target branch changed underneath the execution plan.

Direct writes to the target branch would also destroy the provenance needed by later Review and Integrator phases.

## Decision

Every mutating task run owns one deterministic branch:

```text
orchestra/<projectId>/<taskId>/<runId>
```

At execution start Orchestra captures the repository default branch and its exact head SHA. That SHA is the immutable execution base for all runs in the current scheduler execution.

A mutating Worker receives:

- repository URL;
- target branch;
- immutable base SHA;
- exact task branch;
- task scope;
- protocol identity.

The Worker must create/push the exact task branch from the supplied base and report a full 40-character commit SHA plus exact changed files.

The Worker report is not trusted by itself. `GitProvider` independently validates:

1. target branch still points to the captured base SHA;
2. expected task branch exists;
3. branch head equals reported commit;
4. GitHub compare merge-base equals the captured base;
5. branch is ahead and not behind that base;
6. actual changed files are inside `scope.allow` and outside `scope.deny`;
7. Worker-reported changed files exactly match the provider comparison.

Only then may scheduler move the task to `DONE_UNVERIFIED`. Review remains a separate Phase 7 concern.

The first provider implementation is read-only `GitHubRestProvider`, using `https://api.github.com/*`. It intentionally does not store credentials or mutate GitHub. Workers perform branch creation/push through whatever repository capability is available in their ChatGPT environment.

If the repository cannot be independently read by the provider, validation fails closed. There is no worker-trust fallback.

## Consequences

Positive:

- run provenance is deterministic;
- stale or fabricated commit metadata cannot unlock dependencies;
- target-branch movement is detected before additional dispatch and at artifact validation;
- changed-files scope is based on GitHub compare, not Worker narration;
- Phase 7 can review a stable branch/commit artifact;
- Phase 8 can integrate branches without changing scheduler identity.

Trade-offs:

- unauthenticated GitHub REST primarily supports public repositories and is subject to rate limits;
- private repositories require a future authenticated provider/connector path before they can pass the independent validation gate;
- target branch movement currently stops execution rather than automatically rebasing tasks;
- abandoned task branches are retained for audit/manual cleanup until later lifecycle policy is implemented.

## Alternatives considered

### Trust Worker-provided branch/commit fields

Rejected. It provides metadata but no independent evidence.

### Let Workers push directly to the target branch

Rejected. It destroys isolation and makes parallel work unsafe.

### Add GitHub credentials to extension storage in Phase 6

Rejected for this phase. Credential lifecycle and secret handling are a larger security surface. The provider boundary allows an authenticated implementation later without changing task/run state.

### Automatically rebase when target branch moves

Deferred. Automatic rebase is an integration/reconciliation action and belongs to later phases. Phase 6 fails closed instead.
