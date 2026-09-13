(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};
  const PROMPT_VERSION = 2;

  function json(value) { return JSON.stringify(value ?? null, null, 2); }

  function buildReviewPrompt({ project, task, review, packet, agentId }) {
    if (!project?.projectId || !task?.id || !review?.reviewId || !agentId) throw new Error("invalid_review_assignment");
    if (agentId === review.authorAgentId) throw new Error("self_review_forbidden");
    const contextService = root.ContextPackets?.getDefaultService?.();
    const contextPacket = contextService?.buildReviewPacket?.({ project, task, review, packet, agentId }) || {
      packetVersion: 0,
      packetType: "review",
      project: { projectId: project.projectId, repository: project.repository, immutableGoal: project.initialGoal },
      task,
      evidence: packet,
      provenance: { promptContractVersion: PROMPT_VERSION, generatedFromPersistedState: true, transcriptCopied: false }
    };
    const identity = { v: 1, projectId: project.projectId, taskId: task.id, runId: review.reviewId, agentId };
    const approvedExample = {
      ...identity,
      event: "REVIEW_APPROVED",
      eventId: `${review.reviewId}-final`,
      sequence: 1,
      payload: {
        summary: "why the implementation satisfies the task",
        criteria: (task.acceptanceCriteria || []).map((criterion) => ({ criterion, status: "PASS", evidence: "specific evidence" })),
        scopeCheck: { status: "PASS", evidence: "validated artifact stays within task scope" },
        testsAssessment: { status: "PASS", evidence: "reviewed worker test evidence" },
        issues: [],
        requiredChanges: []
      }
    };

    return [
      "You are the independent ChatGPT Orchestra Reviewer for one completed task.",
      `Reviewer prompt contract version: ${PROMPT_VERSION}.`,
      "This turn is self-contained. Do not rely on previous chat history, including any prior Worker/Reviewer conversation.",
      "The PORTABLE REVIEW PACKET below is the authoritative bounded evidence assembled from persisted state and independently fetched Git evidence.",
      "You are not the author of this run. Review the supplied packet independently and do not modify the repository.",
      "Do not approve because the Worker said DONE. Compare the result against every acceptance criterion, task scope, verification evidence and known limitations.",
      "Do not claim MERGED, VERIFIED or integrated. This role only produces review approval or requests rework.",
      "",
      `PORTABLE REVIEW PACKET:\n${json(contextPacket)}`,
      "",
      "REVIEW RULES:",
      "- Evaluate every acceptance criterion explicitly. Use the exact criterion text in payload.criteria.",
      "- REVIEW_APPROVED is allowed only if every acceptance criterion is PASS and scopeCheck is PASS.",
      "- If any criterion is unsatisfied, evidence is insufficient, tests are materially inadequate, or the diff violates intended scope, return CHANGES_REQUIRED.",
      "- issues must be structured objects when problems exist: severity, code, message, evidence, file (optional), suggestion (optional).",
      "- requiredChanges must be concrete, bounded actions the rework Worker can execute.",
      "- Treat independently validated Git metadata as provenance, not as proof that acceptance criteria are satisfied.",
      "- Do not emit a second protocol line. The final non-empty line must be the one @@ORCH event.",
      "",
      "PROTOCOL CONTRACT:",
      `- Identity: ${json(identity)}`,
      `- eventId must be ${review.reviewId}-final and sequence must be 1.`,
      "- Finish with REVIEW_APPROVED or CHANGES_REQUIRED. Use BLOCKED/ERROR/NEEDS_USER only when review itself cannot be completed.",
      `- APPROVED example: @@ORCH ${JSON.stringify(approvedExample)}`
    ].join("\n");
  }

  root.ReviewPrompts = Object.freeze({ PROMPT_VERSION, buildReviewPrompt });
  if (typeof module !== "undefined" && module.exports) module.exports = root.ReviewPrompts;
})();