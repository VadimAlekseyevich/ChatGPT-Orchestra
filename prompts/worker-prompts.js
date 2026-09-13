(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};
  const PROMPT_VERSION = 5;

  function json(value) { return JSON.stringify(value ?? null, null, 2); }
  function bytes(value) {
    const serialized = typeof value === "string" ? value : JSON.stringify(value);
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(serialized).length;
    if (typeof Buffer !== "undefined") return Buffer.byteLength(serialized, "utf8");
    return serialized.length;
  }
  function sameJson(left, right) { return JSON.stringify(left ?? null) === JSON.stringify(right ?? null); }
  function hasStructuralTruncation(value) {
    if (!value || typeof value !== "object") return false;
    if (Object.prototype.hasOwnProperty.call(value, "_truncatedItems") || Object.prototype.hasOwnProperty.call(value, "_truncatedFields")) return true;
    if (Array.isArray(value)) return value.some(hasStructuralTruncation);
    return Object.values(value).some(hasStructuralTruncation);
  }
  function packetCompleteness(packet, { task = null, gitAssignment = null, reworkContext = null } = {}) {
    if (Number(packet?.packetVersion) < 1) return { ok: true, legacyFallback: true };
    const maxBytes = Number(root.ContextPackets?.BUDGETS?.task || 26000);
    const actualBytes = bytes(packet);
    const incompleteSections = ["task", "dependencies", "assignment", "artifactRefs"].filter((key) => hasStructuralTruncation(packet?.[key]));
    if (task && !sameJson(task, packet?.task)) incompleteSections.push("task_compacted");
    if (gitAssignment && !sameJson(gitAssignment, packet?.assignment?.git)) incompleteSections.push("git_assignment_compacted");
    if (reworkContext && !sameJson(reworkContext, packet?.assignment?.rework)) incompleteSections.push("rework_context_compacted");
    const budgetOk = packet?.budget?.withinBudget === true && actualBytes <= maxBytes;
    const unique = [...new Set(incompleteSections)];
    return { ok: budgetOk && unique.length === 0, reason: budgetOk && !unique.length ? null : "context_packet_incomplete", actualBytes, maxBytes, incompleteSections: unique };
  }
  function failClosedPacket(packet, gate) {
    return {
      packetVersion: Number(packet?.packetVersion) || 1,
      packetType: "task",
      identity: packet?.identity || null,
      logicalRole: packet?.logicalRole || null,
      project: packet?.project ? { projectId: packet.project.projectId, repository: packet.project.repository || null } : null,
      provenance: packet?.provenance || null,
      completeness: gate
    };
  }

  function buildWorkerPrompt({ project, task, runId, agentId, gitAssignment = null, reworkContext = null, packet = null }) {
    if (!project?.projectId || !task?.id || !runId || !agentId) throw new Error("invalid_worker_assignment");
    const contextService = root.ContextPackets?.getDefaultService?.();
    const contextPacket = packet || contextService?.buildTaskPacket?.({ project, task, runId, agentId, gitAssignment, reworkContext }) || {
      packetVersion: 0,
      packetType: "task",
      project: { projectId: project.projectId, repository: project.repository, immutableGoal: project.initialGoal },
      task,
      assignment: { git: gitAssignment, rework: reworkContext },
      provenance: { promptContractVersion: PROMPT_VERSION, generatedFromPersistedState: true, transcriptCopied: false }
    };
    const completeness = packetCompleteness(contextPacket, { task, gitAssignment, reworkContext });
    const eventBase = { v: 1, projectId: project.projectId, taskId: task.id, runId, agentId };
    if (!completeness.ok) {
      return [
        "You are a ChatGPT Orchestra Worker for one bounded logical task.",
        `Worker prompt contract version: ${PROMPT_VERSION}.`,
        "This turn is FAIL-CLOSED because the portable task packet is incomplete.",
        "Do NOT inspect or modify the repository, create/fetch a task branch, run tests, infer omitted task context, or attempt the assignment.",
        `PORTABLE TASK PACKET:\n${json(failClosedPacket(contextPacket, completeness))}`,
        "PROTOCOL CONTRACT:",
        `- Identity: ${json(eventBase)}`,
        "- Emit NEEDS_USER with sequence=1, the normal run-scoped eventId, and payload.reason=context_packet_incomplete.",
        "- Include packet.completeness in payload details. DONE, BLOCKED and ERROR are not valid outcomes for this turn.",
        "- The final non-empty line must be exactly one @@ORCH JSON envelope; no text follows it."
      ].join("\n");
    }

    const gitRequired = gitAssignment?.required !== false;
    const localArtifactMode = Boolean(gitRequired && project?.repositoryRuntime?.repositoryId);
    const gitExample = gitRequired && !localArtifactMode ? {
      branch: gitAssignment.branch,
      commit: "0123456789abcdef0123456789abcdef01234567",
      baseSha: gitAssignment.baseSha,
      targetBranch: gitAssignment.targetBranch,
      changedFiles: ["path/actually/changed.ext"]
    } : undefined;
    const localChangesExample = localArtifactMode ? {
      format: "file-set-v1",
      files: [
        { path: "src/example.js", operation: "write", content: "complete UTF-8 file contents after your change\n" },
        { path: "src/obsolete.js", operation: "delete" }
      ]
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
        ...(localArtifactMode ? { localChanges: localChangesExample } : gitRequired ? { git: gitExample } : {})
      }
    };

    const startSha = gitAssignment?.startSha || gitAssignment?.baseSha || "";
    const gitInstructions = gitRequired ? (localArtifactMode ? [
      "LOCAL WORKTREE ARTIFACT CONTRACT:",
      `- Orchestra already prepared an isolated local worktree from start SHA ${startSha}. You do not need filesystem access to that worktree.`,
      "- Do NOT push an intermediate task branch and do NOT fabricate a commit SHA. Desktop Orchestra will apply, scope-check, test and commit your changes locally.",
      "- Return the complete intended text changes as payload.localChanges using format=file-set-v1.",
      "- Each file entry is {path, operation:'write', content:'complete UTF-8 file contents'} or {path, operation:'delete'}.",
      "- Paths must be repository-relative, must not contain '..', and must stay inside task scope.allow and outside scope.deny.",
      "- file-set-v1 is intentionally bounded: at most 64 files, at most 128 KiB per written file and 256 KiB total written content.",
      "- Do not include binary files in file-set-v1. If the correct task requires a binary/oversized artifact, return NEEDS_USER with reason=local_change_set_unsupported instead of pushing behind Orchestra's back.",
      "- Desktop Orchestra independently derives changed files, runs the structured local verification plan, creates the local task commit and provides a host-generated diff to an independent Reviewer.",
      "- DONE payload.localChanges is mandatory for this mutating local-bound task. payload.git is not required."
    ] : [
      "GIT ISOLATION CONTRACT:",
      `- Target branch: ${gitAssignment.targetBranch}`,
      `- Immutable execution base SHA used for validation: ${gitAssignment.baseSha}`,
      `- Required task branch for this run: ${gitAssignment.branch}`,
      `- Create this run branch from exactly: ${startSha}.`,
      reworkContext?.previousCommit
        ? "- This is a rework run. The start SHA is the previous reviewed task artifact so your branch must preserve prior accepted work and apply requested corrections on top of it."
        : "- This is an initial run. The start SHA is the immutable execution base.",
      "- Never commit or push directly to the target branch.",
      "- Never reuse another task/run branch. This run owns only the exact branch above.",
      "- Push the task branch before reporting DONE. A local-only commit is not a valid artifact in this legacy remote mode.",
      "- Keep all changed files inside task scope.allow and outside scope.deny. Renames must keep both old and new paths inside allowed scope.",
      "- Do not fabricate branch/commit metadata. Orchestra independently checks GitHub branch head, merge base and compare files.",
      "- DONE payload.git is mandatory and must contain branch, full 40-char commit SHA, baseSha, targetBranch and exact changedFiles.",
      "- If Git access, branch creation or push is unavailable, return BLOCKED/NEEDS_USER instead of bypassing isolation.",
      `- Cleanup policy: ${gitAssignment.cleanupPolicy || "retain_until_review_or_manual_cleanup"}. Do not delete the branch yourself after DONE.`
    ]) : [
      "GIT ISOLATION CONTRACT:",
      "- This task kind is explicitly non-mutating; no Git artifact is required.",
      "- Do not make repository changes unless the assignment itself is wrong; report BLOCKED if mutation becomes necessary."
    ];

    const reworkInstructions = reworkContext ? [
      "",
      "REWORK CONTRACT:",
      "- This run exists because an independent Reviewer returned CHANGES_REQUIRED.",
      "- Address every requiredChanges item from contextPacket.assignment.rework. Do not silently ignore a finding; if one is incorrect or impossible, return BLOCKED/NEEDS_USER with evidence."
    ] : [];

    return [
      "You are a ChatGPT Orchestra Worker executing one bounded task.",
      `Worker prompt contract version: ${PROMPT_VERSION}.`,
      "This turn is self-contained. Do not rely on previous chat messages for task or project memory.",
      "The PORTABLE TASK PACKET below is the authoritative bounded context. Persisted artifact references replace transcript copying.",
      "Work only on the assigned task. Do not broaden scope without reporting BLOCKED or NEEDS_USER.",
      "Do not claim APPROVED, VERIFIED or MERGED. DONE means the run is complete and its result is ready for independent host validation and Reviewer evaluation.",
      "",
      `PORTABLE TASK PACKET:\n${json(contextPacket)}`,
      "",
      "PACKET COMPLETENESS GATE:",
      "- The v1 packet passed host-side size, structural and critical-source round-trip checks.",
      "",
      ...gitInstructions,
      ...reworkInstructions,
      "",
      "PROTOCOL CONTRACT:",
      `- Identity: ${json(eventBase)}`,
      "- This assignment expects one final protocol event in this response. Use sequence=1.",
      `- Use eventId=${runId}-final for the final event; runId makes it unique across assignments.`,
      "- Finish with exactly one of DONE, BLOCKED, ERROR or NEEDS_USER.",
      "- The final non-empty response line must be one valid @@ORCH JSON envelope; no text may follow it and do not emit a second @@ORCH line.",
      `- DONE example: @@ORCH ${JSON.stringify(finalExample)}`,
      localArtifactMode
        ? "- For DONE payload include summary, testsPerformed, knownLimitations and localChanges. Do not include fake git commit metadata."
        : "- For DONE payload include summary, testsPerformed and knownLimitations. For mutating remote-mode tasks payload.git is mandatory as specified above.",
      "- For BLOCKED/ERROR use the same identity/eventId/sequence and include reason plus retryable=true/false. Use NEEDS_USER when external user input, permission or complete context is required."
    ].join("\n");
  }

  root.WorkerPrompts = Object.freeze({ PROMPT_VERSION, buildWorkerPrompt, packetCompleteness });
  if (typeof module !== "undefined" && module.exports) module.exports = root.WorkerPrompts;
})();