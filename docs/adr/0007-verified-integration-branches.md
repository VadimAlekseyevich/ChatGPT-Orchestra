# 0007 — Verified integration branches and bounded semantic remediation

Status: Accepted  
Date: 2026-09-13

## Context

Phase 7 produces independently `APPROVED` task branches, but approval of isolated changes does not prove that those branches compose into one coherent repository state. Parallel changes can fail in two distinct ways:

- Git reports a textual merge conflict;
- Git merges cleanly, but integration tests reveal semantic incompatibility.

Allowing an LLM Integrator to write the target branch directly would make conflict handling difficult to verify and would turn a conversational assertion into an irreversible side effect. Cherry-pick or squash composition would also erase the simple provenance relation between reviewed task commits and the final integration result.

## Decision

ChatGPT Orchestra uses a persisted, dynamically allocated Integrator role and a unique integration branch for every integration run:

```text
orchestra/<projectId>/integration/<integrationRunId>
```

The integration branch starts at the immutable Phase 6 base SHA. The target branch must remain at that exact SHA during Phase 8.

Approved mutating task branches are integrated with merge commits in deterministic DAG-derived order:

```bash
git merge --no-ff --no-edit <task-branch>
```

Squash, rebase and cherry-pick are forbidden for normal task composition because the service worker independently verifies that every approved task commit remains an ancestor of the integration head and appears as the expected second parent in first-parent merge history.

The order is topological first. Among simultaneously eligible tasks, foundational schema/API/protocol/core work is preferred, then ordinary consumers, then isolated tests/docs where dependencies permit. Priority and task ID are deterministic tie-breakers. Completion time is never an ordering input.

The final target policy for alpha.9 is fixed to:

```text
integration_branch_only
```

Phase 8 never performs a direct target-branch write. Its terminal success state is `INTEGRATION_VERIFIED`, meaning a remote integration branch has passed independent provenance and verification checks while the target branch remains unchanged.

Text conflicts and semantic conflicts are distinct structured `CONFLICT` classes. Text conflicts may be attributed from the current merge plus approved artifact file ownership. Semantic conflicts require explicit responsible upstream task IDs plus failed-check evidence; the orchestrator does not guess semantic responsibility from test names alone.

Conflicts create persisted bounded integration repair tasks. Repairs operate only on the integration branch, retain approved task commits as ancestors, and are limited to the union of already approved artifact files. The default repair budget is two attempts per integration run; exhaustion escalates to `NEEDS_USER`.

Integration `DONE`, `CONFLICT` and other events using `taskId=integration` are privileged and require an exact bound protocol context before Event Store idempotency reservation.

Final acceptance independently checks:

- target branch still equals the immutable base SHA;
- integration branch head equals the reported full commit SHA;
- merge base equals the captured base;
- integration is not behind base;
- reported changed files equal GitHub compare;
- changed files stay inside the approved artifact union;
- every approved task commit is an ancestor of the integration head;
- first-parent merge order matches the deterministic order;
- every required integration verification command reports PASS with evidence.

## Consequences

Benefits:

- reviewed task provenance remains mechanically verifiable after composition;
- the target branch is insulated from incomplete or conflicting integration attempts;
- textual and semantic conflicts have explicit remediation paths;
- integration ordering is reproducible and independent of chat timing;
- a Worker/Integrator claim is insufficient without remote Git evidence;
- abandoned or stale integration runs cannot silently mutate the canonical target.

Costs:

- integration branches and merge commits add repository history and cleanup work;
- first-parent validation intentionally constrains merge strategy;
- semantic attribution is conservative and can escalate to the user when evidence is insufficient;
- repairs cannot introduce broad refactors outside approved artifact file scope;
- final promotion of a verified integration branch into the target branch remains a separate policy/action.

## Alternatives considered

### Direct merge to the target branch

Rejected because an erroneous Integrator action would be immediately canonical and difficult to reconcile safely after MV3 restart or stale events.

### Cherry-pick approved commits

Rejected for Phase 8 because cherry-picked commits receive new identities and weaken simple ancestry/provenance validation.

### Squash all approved branches

Rejected because it destroys per-task commit ancestry and makes independent proof of inclusion harder.

### Let the Integrator resolve every conflict in the same turn

Rejected because conflict discovery and remediation should be separate persisted steps with bounded attempts and auditable responsibility.

### Automatically infer semantic responsibility

Rejected because failing integration tests often do not uniquely identify the upstream change that caused incompatibility. Explicit attribution plus evidence is safer.

### Automatically merge verified integration into the target branch

Deferred. Alpha.9 deliberately ends at `INTEGRATION_VERIFIED`; target-branch promotion needs a separately explicit policy and must compose cleanly with Phase 9 recovery semantics.
