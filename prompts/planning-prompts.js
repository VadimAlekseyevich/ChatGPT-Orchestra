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
    DISCOVERY: "Inspect the repository before planning. Identify stack, entrypoints, build/test/lint/typecheck commands, modules, persistence/schema, CI, conventions, existing AGENTS.md or contributor instructions, sensitive areas and likely architectural constraints. Do not implement code.",
    PLAN_V1: "Create an implementation plan grounded in discovery. State architecture choices, milestones, dependencies, risks, verification strategy and completion definition. Do not decompose into tiny worker tasks yet.",
    CRITIQUE: "Act as a hostile plan critic. Find hidden dependencies, oversized or underspecified work, fake parallelism, file/scope overlap, missing tests, unclear acceptance criteria, migrations without compatibility, breaking API/security risks and unverifiable outcomes. Return concrete corrections.",
    PLAN_V2: "Rewrite the plan using the critique. Resolve every material critique or explicitly justify why it is rejected. Produce the plan that should be decomposed.",
    DECOMPOSE: "Convert the approved plan into a dependency DAG of minimum independently verifiable and mergeable tasks. Maximize safe parallelism, not task count. Each task must contain id, title, objective, kind, dependencies, scope.allow, optional scope.deny, acceptanceCriteria, verification or verificationWaiver, priority and risk. Include objectiveCoveredBy with task ids that collectively complete the project goal.",
    DAG_CRITIC: "Critique the proposed task graph as an execution graph. Fix cycles, missing dependencies, hidden shared-resource conflicts, vague scopes, missing acceptance/verification, tasks that are too large or too small, and objective coverage. Return the complete corrected taskGraph, not a patch."
  };

  function expectedArtifact(stage) {
    if (stage === "DECOMPOSE" || stage === "DAG_CRITIC") return "a JSON taskGraph object with tasks[] and objectiveCoveredBy[]";
    return "a JSON object containing the complete artifact for this stage";
  }

  function buildPlanningPrompt({ stage, project, agentId, runId }) {
    const normalizedStage = String(stage || "").toUpperCase();
    if (!STAGES.includes(normalizedStage)) throw new Error(`unknown_planning_stage:${normalizedStage}`);
    const taskId = `planning:${normalizedStage.toLowerCase()}`;
    const context = artifactFor(project, normalizedStage);
    return [
      `You are the ChatGPT Orchestra Lead executing planning stage ${normalizedStage}.`,
      `Prompt contract version: ${PROMPT_VERSION}.`,
      "Do not edit code or push commits in Phase 4. Work only on analysis/planning artifacts.",
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
      `Return ${expectedArtifact(normalizedStage)} in payload.artifact.`,
      "Your final non-empty line MUST be exactly one Orchestra Protocol v1 JSON envelope and there must be no text after it.",
      `Use event DONE, projectId=${project.projectId}, taskId=${taskId}, runId=${runId}, agentId=${agentId}, sequence=1, and a fresh unique eventId.`,
      `The envelope payload MUST have shape {\"stage\":\"${normalizedStage}\",\"artifact\":{...}}.`,
      "Do not put markdown fences around the final @@ORCH line."
    ].join("\n");
  }

  root.PlanningPrompts = Object.freeze({ PROMPT_VERSION, STAGES, buildPlanningPrompt });
  if (typeof module !== "undefined" && module.exports) module.exports = root.PlanningPrompts;
})();