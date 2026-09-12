(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};
  const PROMPT_VERSION = 1;

  function json(value) { return JSON.stringify(value ?? null, null, 2); }

  function buildWorkerPrompt({ project, task, runId, agentId }) {
    if (!project?.projectId || !task?.id || !runId || !agentId) throw new Error("invalid_worker_assignment");
    const eventBase = {
      v: 1,
      projectId: project.projectId,
      taskId: task.id,
      runId,
      agentId
    };
    return [
      "You are a ChatGPT Orchestra Worker executing one bounded task.",
      `Worker prompt contract version: ${PROMPT_VERSION}.`,
      "Work only on the assigned task. Do not broaden scope without reporting BLOCKED or NEEDS_USER.",
      "Phase 5 schedules work but Phase 6 Git isolation is not active yet. Never push or merge directly to the repository target branch. If safe isolated editing is unavailable, perform analysis/tests that are safe and report BLOCKED rather than modifying the target branch unsafely.",
      "Do not claim APPROVED, VERIFIED or MERGED. A DONE event means only that you consider this run complete; Orchestra records it as DONE_UNVERIFIED.",
      "",
      `PROJECT ID: ${project.projectId}`,
      `REPOSITORY: ${project.repository?.url || "unknown"}`,
      `PROJECT GOAL:\n${project.initialGoal || ""}`,
      "",
      `TASK:\n${json(task)}`,
      "",
      "PROTOCOL CONTRACT:",
      `- Identity for every event: ${json(eventBase)}`,
      "- eventId must be fresh and unique for every emitted event.",
      "- sequence starts at 1 and increases monotonically within this run.",
      "- You may emit TASK_ACCEPTED or PROGRESS while working.",
      "- Finish with exactly one of DONE, BLOCKED, ERROR or NEEDS_USER.",
      "- The final non-empty response line must be a valid @@ORCH JSON envelope and no text may follow it.",
      "- For DONE payload include summary, testsPerformed, knownLimitations and changedFiles if known. Do not invent commits or branches.",
      "- For BLOCKED/ERROR include reason and retryable=true/false. Use NEEDS_USER when external user input/permission is required."
    ].join("\n");
  }

  root.WorkerPrompts = Object.freeze({ PROMPT_VERSION, buildWorkerPrompt });
  if (typeof module !== "undefined" && module.exports) module.exports = root.WorkerPrompts;
})();
