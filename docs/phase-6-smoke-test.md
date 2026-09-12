# Phase 6 — Local Smoke Test

Run this before relying on `2.0.0-alpha.7` for repository-changing tasks.

## Node regression suite

```powershell
npm test
npm run test:phase6
```

Both commands must exit successfully.

## Preconditions

Use a disposable **public** GitHub repository for the first alpha.7 smoke test. The initial independent validator uses unauthenticated GitHub REST and intentionally fails closed for repositories it cannot read.

Ensure the ChatGPT Worker environment has permission/capability to create and push branches to that repository.

## Edge execution smoke test

1. Pull latest `main`, reload the unpacked extension in `edge://extensions/`, and refresh registered ChatGPT tabs.
2. Register Lead and create at least one Worker.
3. Plan a small code task with a narrow scope, for example `src/demo/**`, until the project reaches `READY`.
4. Press **Start Execution**.
5. Inspect scheduler state and confirm a Git base snapshot exists with `targetBranch` and a 40-character `baseSha`.
6. Confirm Worker receives an exact branch in this shape:

```text
orchestra/<projectId>/<taskId>/<runId>
```

7. Worker must create the branch from the supplied base SHA, commit inside scope and push that exact branch.
8. Worker final `DONE` payload must contain `git.branch`, `git.commit`, `git.baseSha`, `git.targetBranch` and exact `git.changedFiles`.
9. Confirm scheduler records `git_artifact_valid` before `task_done_unverified`.
10. Confirm task becomes `DONE_UNVERIFIED`, not `APPROVED`, `MERGED` or `VERIFIED`.

## Negative checks

Repeat with deliberately wrong metadata one case at a time. Each case must fail without unlocking dependencies:

- wrong branch name;
- shortened/non-40-character commit SHA;
- reported commit differs from remote task-branch head;
- branch was created from a different base;
- changed file is outside `scope.allow`;
- changed file matches `scope.deny`;
- Worker omits a file from `changedFiles`;
- Worker reports an extra file not present in GitHub compare.

Artifact-level failures may retry while retry budget remains. The failed run and its branch provenance must remain in history.

## Target movement check

After execution captures `baseSha` but before a Worker completes, move the target branch by adding a commit through a separate actor. The Worker `DONE` must not be accepted. Scheduler/project should stop in `NEEDS_USER` with reason `target_branch_moved` rather than silently rebasing or treating the old branch as fresh.

## Private/unavailable repository check

Use a repository not readable through the extension's current GitHub REST provider. `Start Execution` or validation must fail closed; Orchestra must not downgrade to trusting Worker-provided branch/commit fields.

## Direct-push safety check

The Worker prompt must explicitly forbid committing or pushing directly to the target branch. If isolated branch creation/push is unavailable, Worker should return `BLOCKED` or `NEEDS_USER`.

## Cleanup policy check

Retry a run and verify the retry receives a **new branch** because `runId` changed. The abandoned branch is retained; alpha.7 does not delete it automatically.
