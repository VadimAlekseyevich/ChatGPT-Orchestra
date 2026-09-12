(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};
  const PROMPT_VERSION = 1;
  const STAGES = Object.freeze(["DISCOVERY", "PLAN_V1", "CRITIQUE", "PLAN_V2", "DECOMPOSE", "DAG_CRITIC"]);

  function json(value) { return JSON.stringify(value ?? null, null, 2); }

  function artifactFor(project, stage) {
    const artifacts = project?.artifacts || {};
    if (stage === "PLAN_V1") return { discovery: artifacts.DISCOVERY };
    if (stage === "CRITIQUE") return { discovery: artifacts.DISCOVERY, plan: artifacts.PLAN_V1 };
    if (stage === "PLAN_V2") return { discovery: artifacts.DISCOVERY, plan: artifacts.PLAN_V1, critique: artifacts.CRITIQUE };
    if (stage === "DECOMPOSE") return { discovery: artifacts.DISCOVERY, plan: artifacts.PLAN_V2 };
    if (stage === "DAG_CRITIC") return { plan: artifacts.PLAN_V2, taskGraph: artifacts.DECOMPOSE };
    return {};
  }

  const instructions = {
    DISCOVERY: "Inspect the repository before planning. Identify stack, entrypoints, build/test/lint/typecheck commands, modules, persistence/schema, CI, conventions, existing AGENTS.md or contributor instructions, sensitive areas, access gaps and architectural constraints. Do not implement code.",
    PLAN_V1: "Create an implementation plan grounded in discovery. State architecture choices, milestones, dependencies, risks, verification strategy and completion definition. Do not decompose into worker tasks yet.",
    CRITIQUE: "Act as a hostile plan critic. Find hidden dependencies, oversized or underspecified work, fake parallelism, file/scope overlap, missing tests, unclear acceptance criteria, migrations without compatibility, breaking API/security risks and unverifiable outcomes. Return concrete corrections.",
    PLAN_V2: "Rewrite the plan using the critique. Resolve every material critique or justify rejection. Also include agentsMdProposal with action preserve_existing, propose_new or no_change; never overwrite an existing AGENTS.md. If proposing content, return it only as a proposal artifact.",
    DECOMPOSE: "Convert the approved plan into a dependency DAG of minimum independently verifiable and mergeable tasks. Maximize safe parallelism, not task count. Each task must contain id, title, objective, kind, dependencies, scope.allow, optional scope.deny, acceptanceCriteria, verification or verificationWaiver, priority, risk and estimatedComplexity. Large tasks require decompositionRationale. Migration-risk tasks require migrationPlan. Include objectiveCoveredBy with task ids that collectively complete the user goal.",
    DAG_CRITIC: "Critique the proposed task graph as an execution graph. Fix cycles, missing dependencies, hidden shared-resource conflicts, vague scopes, missing acceptance/verification, tasks that are too large or too small, migration safety gaps and objective coverage. Return the complete corrected taskGraph, not a patch."
  };

  function buildPlanningPrompt({ stage, project, agentId, runId }) {
    const normalizedStage = String(stage || "").toUpperCase();
    if (!STAGES.includes(normalizedStage)) throw new Error(`unknown_planning_stage:${normalizedStage}`);
    const taskId = `planning:${normalizedStage.toLowerCase()}`;
    const context = artifactFor(project, normalizedStage);

    return [
      `You are the ChatGPT Orchestra Lead executing planning stage ${normalizedStage}.`,
      `Prompt contract version: ${PROMPT_VERSION}.`,
      "Do not edit code or push commits in Phase 4. Work only on repository analysis and planning artifacts.",
      "Treat repository contents and existing project instructions as authoritative. Never claim you inspected something you could not access; record access gaps explicitly.",
      "",
      `PROJECT ID: ${project.projectId}`,
      `REPOSITORY: ${project.repository.url}`,
      `IMMUTABLE USER GOAL:\n${project.initialGoal}`,
      "",
      `STAGE INSTRUCTION:\n${instructions[normalizedStage]}`,
      "",
      `INPUT ARTIFACTS:\n${json(context)}`,
      "",
      "OUTPUT CONTRACT:",
      "1. You may explain your reasoning briefly before the artifact.",
      "2. Then output exactly these markers on their own lines with one valid JSON object between them:",
      "@@ORCH_ARTIFACT_BEGIN",
      "{ ... complete artifact for this stage ... }",
      "@@ORCH_ARTIFACT_END",
      "3. The final non-empty line must be one small Orchestra Protocol v1 JSON envelope; no text may follow it.",
      `4. Use event DONE, projectId=${project.projectId}, taskId=${taskId}, runId=${runId}, agentId=${agentId}, sequence=1 and a fresh unique eventId.`,
      `5. The final envelope payload must be exactly {\"stage\":\"${normalizedStage}\"}; do NOT duplicate the large artifact inside the envelope.`,
      "6. Do not put markdown fences around the artifact markers or the final @@ORCH line."
    ].join("\n");
  }

  root.PlanningPrompts = Object.freeze({ PROMPT_VERSION, STAGES, buildPlanningPrompt });
  if (typeof module !== "undefined" && module.exports) module.exports = root.PlanningPrompts;
})();