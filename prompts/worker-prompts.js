(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};
  const PROMPT_VERSION = 2;

  function json(value) { return JSON.stringify(value ?? null, null, 2); }

  function buildWorkerPrompt({ project, task, runId, agentId, gitAssignment = null }) {
    if (!project?.projectId || !task?.id || !runId || !agentId) throw new Error("invalid_worker_assignment");
    const eventBase = { v: 1, projectId: project.projectId, taskId: task.id, runId, agentId };
    const gitRequired = gitAssignment?.required !== false;
    const gitExample = gitRequired ? {
      branch: gitAssignment.branch,
      commit: "0123456789abcdef0123456789abcdef01234567",
      baseSha: gitAssignment.baseSha,
      targetBranch: gitAssignment.targetBranch,
      changedFiles: ["path/actually/changed.ext"]
    } : undefined;
    const finalExample = {
      ...eventBase,
      event: "DONE",
      eventId: `${runId}-final`,
      sequence: 1,
      payload: {
        summary: "what was completed",
        testsPerformed: [],
        knownLimitations: [],
        ...(gitRequired ? { git: gitExample } : {})
      }
    };

    const gitInstructions = gitRequired ? [
      "GIT ISOLATION CONTRACT:",
      `- Target branch: ${gitAssignment.targetBranch}`,
      `- Immutable execution base SHA: ${gitAssignment.baseSha}`,
      `- Required task branch: ${gitAssignment.branch}`,
      "- Start the task branch from exactly the supplied base SHA. Do not base it on a newer target-branch head.",
      "- Never commit or push directly to the target branch.",
      "- Never reuse another task/run branch. This run owns only the exact branch above.",
      "- Push the task branch before reporting DONE. A local-only commit is not a valid artifact.",
      "- Keep all changed files inside task scope.allow and outside scope.deny. Renames must keep both old and new paths inside allowed scope.",
      "- Do not fabricate branch/commit metadata. Orchestra independently checks GitHub branch head, merge base and compare files.",
      "- DONE payload.git is mandatory and must contain branch, full 40-char commit SHA, baseSha, targetBranch and exact changedFiles.",
      "- If Git access, branch creation or push is unavailable, return BLOCKED/NEEDS_USER instead of bypassing isolation.",
      `- Cleanup policy: ${gitAssignment.cleanupPolicy || "retain_until_review_or_manual_cleanup"}. Do not delete the branch yourself after DONE.`
    ] : [
      "GIT ISOLATION CONTRACT:",
      "- This task kind is explicitly non-mutating; no Git artifact is required.",
      "- Do not make repository changes unless the assignment itself is wrong; report BLOCKED if mutation becomes necessary."
    ];

    return [
      "You are a ChatGPT Orchestra Worker executing one bounded task.",
      `Worker prompt contract version: ${PROMPT_VERSION}.`,
      "Work only on the assigned task. Do not broaden scope without reporting BLOCKED or NEEDS_USER.",
      "Do not claim APPROVED, VERIFIED or MERGED. DONE means the run is complete and, for mutating tasks, its Git artifact is ready for independent validation; Orchestra still records the task as DONE_UNVERIFIED until review exists.",
      "",
      `PROJECT ID: ${project.projectId}`,
      `REPOSITORY: ${project.repository?.url || "unknown"}`,
      `PROJECT GOAL:\n${project.initialGoal || ""}`,
      "",
      `TASK:\n${json(task)}`,
      "",
      ...gitInstructions,
      "",
      "PROTOCOL CONTRACT:",
      `- Identity: ${json(eventBase)}`,
      "- This assignment expects one final protocol event in this response. Use sequence=1.",
      `- Use eventId=${runId}-final for the final event; runId makes it unique across assignments.`,
      "- Finish with exactly one of DONE, BLOCKED, ERROR or NEEDS_USER.",
      "- The final non-empty response line must be one valid @@ORCH JSON envelope; no text may follow it and do not emit a second @@ORCH line.",
      `- DONE example: @@ORCH ${JSON.stringify(finalExample)}`,
      "- For DONE payload include summary, testsPerformed and knownLimitations. For mutating tasks payload.git is mandatory as specified above.",
      "- For BLOCKED/ERROR use the same identity/eventId/sequence and include reason plus retryable=true/false. Use NEEDS_USER when external user input or permission is required."
    ].join("\n");
  }

  root.WorkerPrompts = Object.freeze({ PROMPT_VERSION, buildWorkerPrompt });
  if (typeof module !== "undefined" && module.exports) module.exports = root.WorkerPrompts;
})();
