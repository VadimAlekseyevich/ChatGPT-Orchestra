(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};
  const PROMPT_VERSION = 2;

  function json(value) { return JSON.stringify(value ?? null, null, 2); }

  function eventBase(run, agentId) {
    return { v: 1, projectId: run.projectId, taskId: "integration", runId: run.runId, agentId };
  }

  function buildIntegratorPrompt({ project, run, agentId, packet = null }) {
    const base = eventBase(run, agentId);
    const contextService = root.ContextPackets?.getDefaultService?.();
    const contextPacket = packet || contextService?.buildIntegrationPacket?.({ project, run, agentId }) || {
      packetVersion: 0,
      packetType: "integration",
      project: { projectId: project.projectId, repository: project.repository, immutableGoal: project.initialGoal },
      integration: run,
      provenance: { promptContractVersion: PROMPT_VERSION, generatedFromPersistedState: true, transcriptCopied: false }
    };
    return [
      "You are the ChatGPT Orchestra Integrator for one reviewed project.",
      `Integrator prompt contract version: ${PROMPT_VERSION}.`,
      "This turn is self-contained. Do not rely on a previous Integrator chat or Worker transcripts.",
      "The PORTABLE INTEGRATION PACKET below is the authoritative bounded project/merge context assembled from persisted state and artifact references.",
      "Your job is composition only: integrate approved task branches, detect conflicts, run integration verification, and report structured evidence.",
      "Do not modify or push the target branch. Do not squash, rebase or cherry-pick task commits. Use merge commits so approved task commits remain ancestors of the integration head.",
      "",
      `PORTABLE INTEGRATION PACKET:\n${json(contextPacket)}`,
      "",
      "PACKET COMPLETENESS GATE:",
      "- If budget.withinBudget=false, or any `_truncatedItems` marker appears inside integration/task-order/artifact data required for composition, do not merge a partial manifest. Emit NEEDS_USER with reason=context_packet_incomplete.",
      "",
      "GIT CONTRACT:",
      `1. Fetch ${run.targetBranch} and verify it is still exactly ${run.baseSha}. If it moved, stop with NEEDS_USER.`,
      `2. Create/reset only ${run.branch} from exact base ${run.baseSha}.`,
      "3. For each artifact in contextPacket.integration.artifacts, fetch its branch and verify its remote head equals the supplied commit SHA.",
      "4. Merge artifact branches in contextPacket.integration.taskOrder with `git merge --no-ff --no-edit <branch>`.",
      "5. Never replace a merge with squash/rebase/cherry-pick.",
      "6. Push only the integration branch.",
      "7. After all merges, run every contextPacket.integration.verificationCommands entry exactly as supplied.",
      "",
      "TEXT CONFLICT CONTRACT:",
      "- On a textual merge conflict, inspect `git diff --name-only --diff-filter=U`, record the files, then `git merge --abort` so the integration branch remains at the last clean merge.",
      "- Do NOT invent a resolution in the same response. Stop and emit CONFLICT with conflictType=text.",
      "- `mergedTaskIds` must be the exact successfully merged prefix before the conflicting task; `currentTaskId` must be the task that conflicted.",
      "",
      "SEMANTIC CONFLICT CONTRACT:",
      "- If all Git merges are clean but any integration verification command fails because approved changes are incompatible, emit CONFLICT with conflictType=semantic.",
      "- Include failedChecks and the smallest defensible responsibleTaskIds set. Do not report semantic responsibility without evidence.",
      "",
      "SUCCESS CONTRACT:",
      "- DONE is allowed only after every artifact is merged, every verification command passes, and the integration branch is pushed.",
      "- DONE payload.integration must contain branch, full 40-char commit, baseSha, targetBranch, exact mergedTaskIds, exact changedFiles, checks[{command,status:'PASS',evidence}], and summary.",
      "",
      "PROTOCOL CONTRACT:",
      `- Identity: ${json(base)}`,
      "- Initial final event uses sequence=1.",
      `- Use unique eventId beginning with ${run.runId}-.`,
      "- Final non-empty line must be exactly one @@ORCH JSON envelope; nothing follows it.",
      "- Allowed final events for this turn: DONE, CONFLICT, BLOCKED, ERROR, NEEDS_USER.",
      "- For CONFLICT payload include conflictType, currentTaskId (when merge conflict), mergedTaskIds, responsibleTaskIds, files, failedChecks, summary and repairHint."
    ].join("\n");
  }

  function buildRepairPrompt({ project, run, repairTask, agentId, packet = null }) {
    const base = eventBase(run, agentId);
    const contextService = root.ContextPackets?.getDefaultService?.();
    const contextPacket = packet || contextService?.buildIntegrationPacket?.({ project, run, repairTask, agentId }) || {
      packetVersion: 0,
      packetType: "repair",
      project: { projectId: project.projectId, repository: project.repository, immutableGoal: project.initialGoal },
      integration: run,
      repair: repairTask,
      provenance: { promptContractVersion: PROMPT_VERSION, generatedFromPersistedState: true, transcriptCopied: false }
    };
    return [
      "Continue as ChatGPT Orchestra Integrator for a bounded repair turn.",
      `Integrator prompt contract version: ${PROMPT_VERSION}.`,
      "This repair turn is self-contained. The previous Integrator transcript is not required and must not be treated as source of truth.",
      "Use the PORTABLE REPAIR PACKET below; it contains persisted conflict evidence, responsible task summaries and artifact references.",
      "",
      `PORTABLE REPAIR PACKET:\n${json(contextPacket)}`,
      "",
      "PACKET COMPLETENESS GATE:",
      "- If budget.withinBudget=false, or any `_truncatedItems` marker appears inside integration/repair evidence required for this repair, emit NEEDS_USER with reason=context_packet_incomplete instead of guessing omitted state.",
      "",
      "REPAIR RULES:",
      "- Work only on the integration branch. Never write the target branch.",
      "- Keep all approved task commits as ancestors; do not squash/rebase/cherry-pick them away.",
      "- For text conflict: re-run the conflicting merge, resolve only the reported conflict files according to both task intents/acceptance criteria, complete the merge commit, then continue remaining merges in deterministic order.",
      "- For semantic conflict: make the smallest compatibility repair necessary on the integration branch. Do not add unrelated features or touch files outside the union of approved task changedFiles.",
      "- Run every integration verification command again after the repair.",
      "- Push the integration branch before reporting success.",
      "- If another conflict remains, emit a new CONFLICT instead of claiming success.",
      "",
      "SUCCESS CONTRACT:",
      "- On full success emit DONE with the same payload.integration schema as the initial Integrator prompt.",
      "- mergedTaskIds must still equal the full expected merge order and all checks must PASS with evidence.",
      "",
      "PROTOCOL CONTRACT:",
      `- Identity: ${json(base)}`,
      `- Use sequence=${repairTask.nextSequence}.`,
      `- Use a unique eventId beginning with ${run.runId}-repair-${repairTask.attempt}-.`,
      "- Final non-empty line must be one @@ORCH envelope and nothing follows it.",
      "- Allowed final events: DONE, CONFLICT, BLOCKED, ERROR, NEEDS_USER."
    ].join("\n");
  }

  root.IntegrationPrompts = Object.freeze({ PROMPT_VERSION, buildIntegratorPrompt, buildRepairPrompt });
  if (typeof module !== "undefined" && module.exports) module.exports = root.IntegrationPrompts;
})();