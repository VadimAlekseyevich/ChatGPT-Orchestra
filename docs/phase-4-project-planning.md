# Phase 4 — Project Bootstrap and Planning Pipeline

Phase 4 turns the transport/event foundation into a persisted project-planning system. It deliberately stops at a validated task graph: task execution and worker scheduling belong to Phase 5.

## Project bootstrap

The popup accepts two immutable inputs:

- a project/change goal;
- an HTTPS GitHub repository root URL in `owner/repo` form.

`ProjectStore` persists the active project in `chrome.storage.local` under a versioned key. The initial goal, normalized repository identity, stage history, planning artifacts, current planning run, final task graph and deterministic validation result are stored independently from any ChatGPT tab.

The alpha supports one active project at a time. Completed/failed project records remain in the persisted project map so the model does not depend on chat history as its source of truth.

## Planning pipeline

Planning is a staged state machine:

```text
DISCOVERY
  -> PLAN_V1
  -> CRITIQUE
  -> PLAN_V2
  -> DECOMPOSE
  -> DAG_CRITIC
  -> deterministic DAG validation
  -> READY
```

Every stage receives the immutable project goal, repository identity and only the persisted artifacts needed for that stage. The Lead is bound to a unique `projectId/taskId/runId` protocol context before each prompt is sent.

This gives stale-response protection to planning: an old response from an earlier stage/run cannot advance the current project because Phase 3 Event Bus context validation rejects it.

## Stage responsibilities

### DISCOVERY

The Lead is instructed to inspect and report the repository stack, entrypoints, build/test/lint/typecheck commands, major modules, persistence/schema, CI, conventions, existing `AGENTS.md`/contributor instructions, sensitive areas, architecture constraints and access gaps.

It must not implement code.

### PLAN_V1

Builds an implementation plan grounded in discovery, including architecture choices, milestones, dependencies, risks, verification strategy and completion definition.

### CRITIQUE

Acts as a hostile plan critic and searches for hidden dependencies, oversized or underspecified work, fake parallelism, overlapping scope, missing verification/acceptance criteria, migration compatibility risks, breaking APIs, security risks and unverifiable outcomes.

### PLAN_V2

Rewrites the plan after critique. It also records an `agentsMdProposal`; existing `AGENTS.md` is never overwritten automatically in Phase 4.

### DECOMPOSE

Produces a dependency DAG of independently verifiable and potentially mergeable tasks. Each code task is expected to contain objective, dependencies, scope, acceptance criteria, verification strategy, priority, risk and complexity metadata.

### DAG_CRITIC

Returns a complete corrected graph rather than a patch. It must repair hidden dependencies, cycles, vague scopes, unsafe migrations and poor objective coverage before deterministic validation runs.

## Large planning artifacts

Orchestra Protocol v1 intentionally limits the final `@@ORCH` envelope to a small bounded message. A complete plan or task graph can be much larger, so Phase 4 does **not** duplicate large artifacts inside the protocol event.

A successful planning response uses:

```text
@@ORCH_ARTIFACT_BEGIN
{ ... complete JSON artifact ... }
@@ORCH_ARTIFACT_END
@@ORCH {"v":1,"event":"DONE", ... ,"payload":{"stage":"DISCOVERY"}}
```

The artifact parser accepts only a JSON object and applies a size bound. The final line remains the small idempotent Protocol v1 event.

For `BLOCKED`, `ERROR` and `NEEDS_USER` planning events no artifact block is required.

## Persistence and crash window

Accepted planning events persist the parsed planning artifact in their Event Store source metadata, alongside assistant response provenance. Project Store also persists completed stage artifacts.

This intentionally covers the crash window where:

1. Event Bus accepts and persists a `DONE` event;
2. the service worker dies before Planning Engine writes the stage artifact to Project Store.

On restart, Planning Engine restores the active stage context and checks recently accepted events. If it finds the already accepted current-run event with its persisted planning artifact, it advances the pipeline without re-sending the old prompt or repeating the accepted event side effect.

## Deterministic DAG gate

`READY` is not based on the Lead claiming success. The final graph must pass deterministic validation including:

- graph/task shape;
- unique task IDs;
- dependency existence;
- no self-dependencies or cycles;
- title and objective;
- non-empty acceptance criteria;
- non-empty allowed scope;
- verification or explicit waiver for code tasks;
- complexity classification;
- rationale for large tasks;
- migration safety metadata when migration/schema/database risk is declared;
- explicit objective coverage using known task IDs.

The validator also computes topological order and graph statistics. Validation failure moves the project to `NEEDS_USER` instead of `READY`.

## Phase boundary

Phase 4 does **not**:

- assign DAG tasks to Workers;
- run tasks in parallel;
- implement scheduler priority/dependency unlocking;
- create Git task branches;
- review worker changes;
- merge/integrate code;
- implement full project Pause/Resume.

A `READY` project means only: the persisted project has a deterministic, validated execution graph that Phase 5 may consume.
