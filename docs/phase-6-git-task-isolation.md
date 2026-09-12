# Phase 6 — Git Task Isolation

Phase 6 turns Worker completion into a verifiable Git artifact without yet approving or integrating that artifact.

## Execution base

When execution starts, Orchestra queries GitHub REST for the repository default branch and captures its exact head SHA:

```text
provider: github-rest-v1
targetBranch: main
baseSha: <40-char SHA>
```

The snapshot is persisted in SchedulerStore and remains immutable for the execution. If the target branch later moves, Orchestra stops scheduling and moves to `NEEDS_USER` instead of silently rebasing work.

## Per-run branch

Every mutating run receives exactly one branch:

```text
orchestra/<projectId>/<taskId>/<runId>
```

A retry creates a new `runId`, therefore it creates a new branch identity. Old branches remain audit artifacts and are not silently reused.

## Worker contract

For mutating tasks the Worker must:

1. start from the supplied `baseSha`;
2. create/use the exact assigned branch;
3. never push to the target branch;
4. keep changes inside task scope;
5. push the task branch;
6. return `DONE` only after the branch is remotely visible;
7. include `payload.git`:

```json
{
  "branch": "orchestra/P1/T17/R3",
  "commit": "0123456789abcdef0123456789abcdef01234567",
  "baseSha": "...",
  "targetBranch": "main",
  "changedFiles": ["src/example.js"]
}
```

Non-mutating task kinds (`analysis`, `research`, `planning`, `manual`, `no-code`) do not require a Git artifact and must not modify the repository.

## Independent validation

`GitHubRestProvider` validates the artifact independently of Worker text:

- target head still equals execution `baseSha`;
- task branch exists;
- task branch head equals reported commit;
- commit has the captured base as merge base;
- branch is ahead and not behind the captured base;
- actual compare files are inside `scope.allow`;
- actual files do not match `scope.deny`;
- reported `changedFiles` exactly equal GitHub compare files.

A rename is checked conservatively: both the new and previous path must remain inside scope.

## State transitions

```text
RUNNING
   |
   | Worker DONE
   v
GIT VALIDATION
   |              \
   | valid         \ invalid
   v                v
DONE_UNVERIFIED   ARTIFACT_INVALID
                    |
                    +--> READY (retry budget remains)
                    |
                    +--> NEEDS_USER
```

`DONE_UNVERIFIED` still means only “Worker artifact exists and passed deterministic Git checks”. Independent acceptance begins in Phase 7.

## Provider boundary

Phase 6 introduces a provider interface around:

- repository/default-branch lookup;
- branch head lookup;
- base freshness;
- compare/diff metadata;
- artifact validation.

The initial implementation is intentionally read-only. Orchestra itself does not create/delete branches through GitHub REST and does not store GitHub credentials.

## Public/private repository behavior

The initial GitHub REST provider can independently validate repositories readable without extension-held credentials. If GitHub returns unavailable/auth-required/rate-limited results, Orchestra fails closed and escalates instead of accepting Worker metadata on trust.

A future authenticated provider or connector can implement the same interface without changing scheduler/task identities.

## Cleanup policy

Phase 6 records:

```text
retain_until_review_or_manual_cleanup
```

Abandoned/retried run branches are retained for provenance. Automated cleanup is intentionally deferred until review/integration/recovery policy is mature enough to know that a branch is safe to remove.

## Phase boundary

Phase 6 does **not**:

- approve Worker changes;
- decide acceptance criteria;
- merge/cherry-pick/rebase task branches;
- resolve semantic conflicts;
- mark project `VERIFIED`.

Those responsibilities belong to Phase 7 and Phase 8.
