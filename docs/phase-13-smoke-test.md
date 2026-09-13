# Phase 13 Smoke Test — Context Packets

## Local Node gate

```powershell
npm run test:phase13
npm test
```

Expected Phase 13 checks:

- ContextStore reload preserves Lead summary/decisions/packet audit;
- project switch clears previous project context;
- Lead/Task/Review/Integration packets are versioned and within role budget;
- packet JSON contains no `tabId`, `sessionId`, runtime source or transcript fields;
- dependency Git artifacts are represented through compact artifact refs;
- completed task summaries and decision register are bounded;
- the same task logical role can be rebuilt for a different agent identity;
- fresh Lead replacement preserves the existing planning stage/run ID;
- actual serialized packet size is checked at prompt time, not only packet metadata;
- structural truncation in work-critical Lead/Worker/Reviewer/Integrator data fails closed to `NEEDS_USER(context_packet_incomplete)`;
- fail-closed prompts do not carry the structurally incomplete work payload into normal execution instructions;
- Orchestrator API v4 exposes `contextSummary` / `contextPacket` and keeps privileged calls unavailable to agent sessions;
- Portable State exports/imports ContextStore while remaining compatible with alpha.13 bundles that lack the namespace.

## Edge smoke — fresh Lead

1. Start a project and allow planning to enter a stage such as `CRITIQUE`.
2. Record the project ID, stage and current planning run ID from the Dashboard/API.
3. Close the registered Lead tab.
4. Open a brand-new ChatGPT tab.
5. Register it as Lead.
6. Confirm the first new prompt says it is a fresh-session replacement and contains `PORTABLE CONTEXT PACKET`.
7. Confirm protocol context still uses the original project/stage/run ID; a new planning run must not be created.
8. Finish the stage normally and verify planning advances exactly once.
9. Re-register an already live Lead and confirm no duplicate planning prompt is dispatched.

## Edge smoke — Worker replacement

1. Start execution with a runnable task.
2. Close the assigned Worker during the run.
3. Let the existing scheduler/recovery policy create the retry/replacement attempt.
4. Inspect the replacement prompt: it must contain `PORTABLE TASK PACKET` and state that previous chat history is not required.
5. Confirm the logical role remains `task:<projectId>:<taskId>` while the physical agent/run may differ.
6. Complete the task and verify normal Git validation/review still applies.

## Reviewer / Integrator smoke

For a lost Reviewer or Integrator:

- replacement follows the pre-existing requeue/abandon recovery state machine;
- the new prompt contains `PORTABLE REVIEW PACKET` or `PORTABLE INTEGRATION PACKET`;
- no old model transcript is pasted into the prompt;
- validated artifact/merge evidence is still present;
- author/reviewer separation, Git provenance and integration policies remain unchanged.

## Fail-closed packet smoke

Use a development build/test fixture to force one work-critical packet section to contain structural truncation metadata or to exceed its real serialized role budget while metadata still claims `withinBudget=true`.

Expected behavior:

- Lead does not emit a planning artifact or advance stage;
- Worker does not create/fetch a task branch or modify the repository;
- Reviewer does not approve or request rework from partial evidence;
- Integrator/repair does not merge, resolve conflicts, verify, commit or push;
- the only allowed protocol outcome is `NEEDS_USER` with `payload.reason=context_packet_incomplete`;
- the fail-closed bootstrap includes compact completeness diagnostics but does not replay the omitted/incomplete work payload.

## Project Bundle migration

1. Pause/Stop a project after at least one packet has been generated.
2. Export Project Bundle.
3. Confirm `state.namespaces.context` exists.
4. Confirm it contains compact summary/decisions/audit only and no browser session IDs.
5. Import into an empty StateStore/host.
6. Confirm context namespace is restored but runtime agents remain empty and recovery becomes `RECOVERY_REQUIRED`.

## Release gate

Do not call Phase 13 verified if a fresh executor requires scrolling/copying the old ChatGPT conversation to understand its role. Persisted state + packet must be sufficient for the orchestration contract. Do not call it verified if a structurally incomplete work-critical packet can reach normal task/review/integration execution.
