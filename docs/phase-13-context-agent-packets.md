# Phase 13 — Context Management + Portable Agent Packets

Phase 13 removes long-lived ChatGPT conversation history from the logical-role contract. A Lead, Worker, Reviewer or Integrator is now bootstrapped from bounded persisted state plus artifact references instead of relying on an old browser tab transcript.

## Goal

The same unfinished logical role must be reconstructible on a fresh executor session:

```text
persisted project/task/review/integration state
                +
        compact ContextStore
                ↓
       ContextPacketService
                ↓
 versioned bounded role packet
                ↓
 fresh ChatGPT / future desktop executor
```

Chats remain executors, not project memory.

## ContextStore v1

Storage key:

```text
orchestra.context.v1
```

The store persists only compact orchestration memory:

```js
{
  schemaVersion: 1,
  projectId,
  leadSummary,
  decisions: [],
  packetAudit: [],
  updatedAt
}
```

`leadSummary` describes current project/status/task progress/active roles/completed-task summaries/recovery state and planning artifact references. `decisions` is a bounded register synthesized from planning stage history plus scheduler decisions. `packetAudit` records packet type/logical role/prompt version/size/truncation metadata, not model transcripts.

Switching project IDs resets this state so context from one project cannot leak into another.

## Packet schema v1

Every packet contains:

```js
{
  packetVersion: 1,
  packetType,
  logicalRole: {
    role,
    logicalRoleId
  },
  identity: {
    projectId,
    taskId,
    runId,
    agentId
  },
  project: {
    projectId,
    repository,
    immutableGoal,
    status,
    stage
  },
  leadSummary,
  decisions,
  completedTasks,
  provenance: {
    packetVersion,
    budgetPolicyVersion,
    promptContractVersion,
    generatedFromPersistedState: true,
    transcriptCopied: false
  },
  generatedAt,
  budget
}
```

Role-specific fields are added below.

### Lead packet

Adds current planning stage, only the relevant prior planning artifacts and bounded repository context. `logicalRoleId` is:

```text
lead:<projectId>:<stage>
```

### Task packet

Adds the task contract, dependency summaries/artifact refs, Git assignment/rework context and scope-relevant repository context. `logicalRoleId` is:

```text
task:<projectId>:<taskId>
```

A retry can have a new run and new executor while retaining this logical role identity.

### Review packet

Wraps the independently assembled ReviewEngine evidence: task contract, Worker report summary, validated artifact, bounded Git diff, acceptance/scope/verification context and repository rules. It never requires the Worker chat transcript.

```text
review:<projectId>:<taskId>:<iteration>
```

### Integration / repair packet

Adds deterministic integration order, approved artifact provenance, verification commands, compact approved-task summaries and persisted repair/conflict evidence.

```text
integration:<projectId>
```

A replacement Integrator receives the same logical project composition state even when the physical agent/session changes.

## Context budget policy v1

Initial alpha.14 budgets are role-specific and deterministic:

```text
Lead         24k
Task         26k
Review       36k
Integration  36k
Repair       32k
```

The service first removes runtime/transcript-only fields, bounds repository/module lists and completed-task history, then truncates long descriptive strings when necessary. Packet metadata records the effective size and whether compaction occurred.

Prompt builders additionally verify the **actual serialized packet size** instead of trusting only packet metadata. For v1 packets they also search work-critical sections for structural `_truncatedItems` / `_truncatedFields` markers. If required planning/task/review/integration data is structurally incomplete, the prompt fails closed and permits only `NEEDS_USER` with `reason=context_packet_incomplete`; the executor must not infer or execute omitted work.

These are packet budgets, not model token-limit claims. They exist to stop orchestration prompts from growing with project lifetime.

## Transcript and runtime exclusion

Packets recursively omit runtime/session keys such as:

```text
tabId
legacyTabId
sessionId
runtimeSource
browserHandle
pageId
webContentsId
```

and transcript-like fields such as:

```text
transcript
chatHistory
conversationHistory
messages
rawResponse
rawTranscript
```

Git artifacts, review evidence and planning artifacts are persisted domain evidence, not copied chat history.

## Completed-task compaction

Completed tasks are represented as compact summaries containing task identity/status, bounded objective/acceptance/verification data, Git artifact reference, review summary and error information. The orchestration prompt does not replay the original Worker/Reviewer messages.

## Repository context selection

Repository context is derived from persisted discovery/plan artifacts and bounded to relevant stack, entrypoints, commands, modules, repository instructions, architecture rules, sensitive areas and constraints. For Worker packets, module selection prefers paths related to `scope.allow`.

## Fresh Lead replacement

Planning is the one role where a lost chat can interrupt an in-progress stage before a new run is naturally created. `PlanningEngine.resumeCurrentStage()` therefore:

1. requires a persisted `PLANNING` project;
2. reuses the same `projectId`, stage and `currentRunId`;
3. binds the new Lead executor to the same protocol identity;
4. builds a fresh Lead packet from persisted state;
5. sends a replacement prompt without calling `beginStage()` or inventing a new planning run.

`OrchestratorApi v4` invokes this automatically only when an absent/offline Lead is registered while planning is active. Re-registering an already live Lead does not trigger a replacement prompt.

There is intentionally no generic public `resumeLead` command: manually replaying an in-flight planning run while the old executor is still live could duplicate the same logical work.

## Worker / Reviewer / Integrator replacement

Existing execution state machines keep their established safety semantics:

- Worker loss creates a retry run for the same logical task; Worker prompt v4 obtains a fresh Task packet.
- Reviewer loss abandons/requeues the physical review assignment; Reviewer prompt v2 is rebuilt from persisted task/review/Git evidence.
- Integrator loss follows the existing abandon/new-run recovery policy; Integrator prompt v2 is rebuilt from persisted approved artifacts.
- Integration repair turns use a Repair packet containing persisted conflict evidence instead of relying on the previous Integrator transcript.

Phase 13 intentionally does not change Git/review/integration acceptance semantics.

## Orchestrator API v4

New read surfaces:

```text
contextSummary
contextPacket
```

`contextPacket` is an admin/control-plane query and remains behind the same rule that forbids privileged Orchestrator API access from agent/browser sessions.

Fresh-Lead continuation is reached through the existing `registerActiveLead` control path only when the prior logical Lead is absent/offline and the project is still `PLANNING`.

## Portable persistence

`orchestra.context.v1` is now part of Portable State v1. No schema-version bump is required because the namespace is additive and optional:

- alpha.14 export includes ContextStore;
- alpha.13 bundles without it still validate/import;
- missing context is initialized to an empty project-scoped ContextStore;
- runtime/session bindings and secrets are sanitized again during export/import;
- imported projects still enter `RECOVERY_REQUIRED` before dispatch.

## Non-goals

Phase 13 does not add:

- Electron/desktop shell;
- CDP/browser automation;
- a new provider;
- CI/workflow infrastructure;
- embeddings/vector retrieval;
- automatic target-branch promotion.

Those remain later roadmap phases.

## Definition of Done

Phase 13 is complete when a new executor session can receive a bounded role packet reconstructed from persisted Orchestra state, with prompt/version provenance and no dependency on the full old ChatGPT history. Lead replacement must preserve the same planning run identity; Worker/Reviewer/Integrator replacements must continue to obey their existing retry/requeue/recovery state machines. Work-critical packet truncation or real serialized oversize must fail closed instead of allowing partial execution.
