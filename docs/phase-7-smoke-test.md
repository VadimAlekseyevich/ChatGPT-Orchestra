# Phase 7 — Local Smoke Test

Run this before relying on `2.0.0-alpha.8` review decisions.

## Node regression suite

```powershell
npm test
npm run test:phase7
```

Both commands must exit successfully.

## Edge review-loop smoke test

Use a disposable public GitHub repository.

1. Pull latest `main`, reload the unpacked extension in `edge://extensions/`, and refresh registered ChatGPT tabs.
2. Register Lead and use at least two connected Worker tabs.
3. Plan a small code task with two explicit acceptance criteria and a narrow `scope.allow`.
4. Start execution.
5. Let Worker A complete the task on its assigned task branch and return a valid `DONE` Git artifact.
6. Verify the task becomes `DONE_BY_WORKER` / `REVIEW_PENDING`; a dependent task must still remain locked.
7. Verify Reviewer assignment goes to Worker B, never Worker A.
8. Inspect Reviewer prompt: it should contain bounded task/review context, artifact/diff/test evidence, not the full Worker chat transcript.

## Mandatory CHANGES_REQUIRED scenario

For the first review, intentionally make one acceptance criterion fail or have Reviewer return a legitimate structured finding:

```text
criterion: FAIL
requiredChanges: [concrete action]
```

Expected behavior:

- event is `CHANGES_REQUIRED`;
- task returns to `READY`;
- dependency remains locked;
- scheduler creates a new Worker run with a new `runId` and a new task branch;
- rework prompt contains structured review issues and required changes;
- mutating rework branch starts from the previous reviewed task commit;
- old run/review/artifact remain in persisted history.

Then complete rework and let a different eligible Reviewer return a valid `REVIEW_APPROVED` payload. Only then should the task become `APPROVED` and unlock its dependent task.

## Self-review guard

Create a scenario where only the author tab is idle/available for review. The review must remain `PENDING`; Orchestra must never send the review prompt back to the author.

With `maxWorkers=1`, Start Execution should still keep a second connected Worker tab available for independent review while respecting one active-role concurrency slot.

## Reviewer-loss identity check

While a review is active, close the Reviewer tab.

Expected:

- old review is abandoned;
- retry gets a fresh `reviewId`;
- review iteration does not increase merely because the Reviewer was replaced;
- a late event from the abandoned review identity cannot approve the replacement review.

## Review payload validation

Try an incomplete `REVIEW_APPROVED`, for example omit one acceptance criterion or omit evidence. Orchestra must fail closed and must not set the task to `APPROVED`.

## Review iteration limit

Default limit is 3 review iterations. Repeated legitimate `CHANGES_REQUIRED` at the configured limit must transition task/scheduler/project to `NEEDS_USER` rather than create an endless rework loop.

## Terminal Phase 7 state

After every task is independently approved:

```text
scheduler = READY_FOR_INTEGRATION
project   = READY_FOR_INTEGRATION
```

There must be no automatic merge, target-branch write, `MERGED` status or `VERIFIED` status. Those begin in Phase 8.
