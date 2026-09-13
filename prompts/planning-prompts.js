(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};
  const PROMPT_VERSION = 2;
  const STAGES = Object.freeze(["DISCOVERY", "PLAN_V1", "CRITIQUE", "PLAN_V2", "DECOMPOSE", "DAG_CRITIC"]);

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

  function artifactFor(project, stage) {
    const artifacts = project?.artifacts || {};
    if (stage === "PLAN_V1") return { discovery: artifacts.DISCOVERY };
    if (stage === "CRITIQUE") return { discovery: artifacts.DISCOVERY, plan: artifacts.PLAN_V1 };
    if (stage === "PLAN_V2") return { discovery: artifacts.DISCOVERY, plan: artifacts.PLAN_V1, critique: artifacts.CRITIQUE };
    if (stage === "DECOMPOSE") return { discovery: artifacts.DISCOVERY, plan: artifacts.PLAN_V2 };
    if (stage === "DAG_CRITIC") return { plan: artifacts.PLAN_V2, taskGraph: artifacts.DECOMPOSE };
    return {};
  }

  function expectedStageInputs(project, stage) {
    const artifacts = project?.artifacts || {};
    if (stage === "PLAN_V1") return { DISCOVERY: artifacts.DISCOVERY };
    if (stage === "CRITIQUE") return { DISCOVERY: artifacts.DISCOVERY, PLAN_V1: artifacts.PLAN_V1 };
    if (stage === "PLAN_V2") return { DISCOVERY: artifacts.DISCOVERY, PLAN_V1: artifacts.PLAN_V1, CRITIQUE: artifacts.CRITIQUE };
    if (stage === "DECOMPOSE") return { DISCOVERY: artifacts.DISCOVERY, PLAN_V2: artifacts.PLAN_V2 };
    if (stage === "DAG_CRITIC") return { PLAN_V2: artifacts.PLAN_V2, DECOMPOSE: artifacts.DECOMPOSE };
    return {};
  }

  function packetCompleteness(packet, { project = null, stage = "" } = {}) {
    if (Number(packet?.packetVersion) < 1) return { ok: true, legacyFallback: true };
    const maxBytes = Number(root.ContextPackets?.BUDGETS?.lead || 24000);
    const actualBytes = bytes(packet);
    const incompleteSections = hasStructuralTruncation(packet?.stageInputs) ? ["stageInputs"] : [];
    const normalizedStage = String(stage || packet?.stage || "").toUpperCase();
    if (project && !sameJson(expectedStageInputs(project, normalizedStage), packet?.stageInputs || {})) incompleteSections.push("stage_inputs_compacted");
    const budgetOk = packet?.budget?.withinBudget === true && actualBytes <= maxBytes;
    const unique = [...new Set(incompleteSections)];
    return {
      ok: budgetOk && unique.length === 0,
      reason: budgetOk && !unique.length ? null : "context_packet_incomplete",
      actualBytes,
      maxBytes,
      incompleteSections: unique
    };
  }
  function failClosedPacket(packet, gate) {
    return {
      packetVersion: Number(packet?.packetVersion) || 1,
      packetType: "lead",
      identity: packet?.identity || null,
      logicalRole: packet?.logicalRole || null,
      project: packet?.project ? { projectId: packet.project.projectId, repository: packet.project.repository || null } : null,
      stage: packet?.stage || null,
      provenance: packet?.provenance || null,
      completeness: gate
    };
  }

  const instructions = {
    DISCOVERY: "Inspect the repository before planning. Identify stack, entrypoints, build/test/lint/typecheck commands, modules, persistence/schema, CI, conventions, existing AGENTS.md or contributor instructions, sensitive areas, access gaps and architectural constraints. Do not implement code.",
    PLAN_V1: "Create an implementation plan grounded in discovery. State architecture choices, milestones, dependencies, risks, verification strategy and completion definition. Do not decompose into worker tasks yet.",
    CRITIQUE: "Act as a hostile plan critic. Find hidden dependencies, oversized or underspecified work, fake parallelism, file/scope overlap, missing tests, unclear acceptance criteria, migrations without compatibility, breaking API/security risks and unverifiable outcomes. Return concrete corrections.",
    PLAN_V2: "Rewrite the plan using the critique. Resolve every material critique or justify rejection. Include agentsMdProposal with action preserve_existing, propose_new or no_change; never overwrite an existing AGENTS.md. If proposing content, return it only as a proposal artifact.",
    DECOMPOSE: "Convert the approved plan into a dependency DAG of minimum independently verifiable and mergeable tasks. Maximize safe parallelism, not task count. Each task must contain id, title, objective, kind, dependencies, scope.allow, optional scope.deny, acceptanceCriteria, verification or verificationWaiver, priority, risk and estimatedComplexity. Large tasks require decompositionRationale. Migration-risk tasks require migrationPlan. Include objectiveCoveredBy with task ids that collectively complete the user goal.",
    DAG_CRITIC: "Critique the proposed task graph as an execution graph. Fix cycles, missing dependencies, hidden shared-resource conflicts, vague scopes, missing acceptance/verification, tasks that are too large or too small, migration safety gaps and objective coverage. Return the complete corrected taskGraph, not a patch."
  };

  const schemas = {
    DISCOVERY: {
      repositoryAccess: { status: "ok | partial | unavailable", inspectedPaths: ["path"], gaps: ["gap"] },
      stack: ["technology"], entrypoints: ["path"], commands: { build: [], test: [], lint: [], typecheck: [] }, modules: ["module/path"], persistence: ["detail"], ci: ["detail"], instructions: { agentsMd: "present | absent | unknown", paths: [] }, sensitiveAreas: ["area"], constraints: ["constraint"]
    },
    PLAN_V1: { milestones: [{ id: "M1", objective: "...", dependencies: [] }], risks: ["risk"], verificationStrategy: ["check"], completionDefinition: "..." },
    CRITIQUE: { findings: [{ severity: "high | medium | low", issue: "...", correction: "..." }], blockingIssues: ["issue"] },
    PLAN_V2: { milestones: [{ id: "M1", objective: "...", dependencies: [] }], risks: ["risk"], verificationStrategy: ["check"], completionDefinition: "...", agentsMdProposal: { action: "preserve_existing | propose_new | no_change", content: "optional proposal only" } },
    DECOMPOSE: { objectiveCoveredBy: ["T1"], tasks: [{ id: "T1", title: "...", objective: "...", kind: "code", dependencies: [], scope: { allow: ["src/**"], deny: [] }, acceptanceCriteria: ["..."], verification: ["..."], priority: 50, risk: "low", estimatedComplexity: "S | M | L" }] },
    DAG_CRITIC: { objectiveCoveredBy: ["T1"], tasks: ["same complete task objects as DECOMPOSE, corrected"] }
  };

  function buildPlanningPrompt({ stage, project, agentId, runId, packet = null, replacement = false }) {
    const normalizedStage = String(stage || "").toUpperCase();
    if (!STAGES.includes(normalizedStage)) throw new Error(`unknown_planning_stage:${normalizedStage}`);
    const taskId = `planning:${normalizedStage.toLowerCase()}`;
    const contextService = root.ContextPackets?.getDefaultService?.();
    const contextPacket = packet || contextService?.buildLeadPacket?.({ project, stage: normalizedStage, runId, agentId }) || {
      packetVersion: 0,
      packetType: "lead",
      project: { projectId: project.projectId, repository: project.repository, immutableGoal: project.initialGoal },
      stage: normalizedStage,
      stageInputs: artifactFor(project, normalizedStage),
      provenance: { promptContractVersion: PROMPT_VERSION, generatedFromPersistedState: true, transcriptCopied: false }
    };
    const completeness = packetCompleteness(contextPacket, { project, stage: normalizedStage });
    const packetForPrompt = completeness.ok ? contextPacket : failClosedPacket(contextPacket, completeness);
    if (!completeness.ok) {
      return [
        `You are the ChatGPT Orchestra Lead executing planning stage ${normalizedStage}.`,
        `Prompt contract version: ${PROMPT_VERSION}.`,
        replacement ? "This is a fresh-session replacement for the same persisted logical Lead role." : "Treat this turn as self-contained.",
        "This planning turn is FAIL-CLOSED because the portable context packet is incomplete.",
        "Do NOT plan from memory, inspect unrelated history, invent omitted artifacts, advance the stage or emit a planning artifact.",
        `PORTABLE CONTEXT PACKET:\n${json(packetForPrompt)}`,
        "PROTOCOL CONTRACT:",
        `- Identity: ${json({ v: 1, projectId: project.projectId, taskId, runId, agentId })}`,
        "- Emit NEEDS_USER with sequence=1, a fresh eventId and payload.reason=context_packet_incomplete.",
        "- Include packet.completeness in payload details. DONE, BLOCKED and ERROR are not valid outcomes for this turn.",
        "- The final non-empty line must be exactly one @@ORCH JSON envelope; no text follows it."
      ].join("\n");
    }

    return [
      `You are the ChatGPT Orchestra Lead executing planning stage ${normalizedStage}.`,
      `Prompt contract version: ${PROMPT_VERSION}.`,
      replacement ? "This is a fresh-session replacement for the same persisted logical Lead role. Do not depend on any previous chat messages." : "Treat this turn as self-contained. Do not rely on previous chat turns for project memory.",
      "The PORTABLE CONTEXT PACKET below is the authoritative bounded context for this role. Artifact references point to persisted Orchestra state; do not invent missing transcript context.",
      "Do not edit code or push commits in Phase 4. Work only on repository analysis and planning artifacts.",
      "Treat repository contents and existing project instructions as authoritative. Never claim you inspected something you could not access; record access gaps explicitly.",
      "If repository access is unavailable, report repositoryAccess.status=unavailable instead of guessing repository facts.",
      "",
      `PORTABLE CONTEXT PACKET:\n${json(packetForPrompt)}`,
      "",
      "PACKET COMPLETENESS GATE:",
      "- The v1 packet passed host-side size, structural and critical-source round-trip checks.",
      "",
      `STAGE INSTRUCTION:\n${instructions[normalizedStage]}`,
      "",
      `REQUIRED ARTIFACT SHAPE:\n${json(schemas[normalizedStage])}`,
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
      "6. If you cannot proceed, emit BLOCKED or NEEDS_USER with a small reason payload instead of inventing an artifact.",
      "7. Do not put markdown fences around the artifact markers or the final @@ORCH line."
    ].join("\n");
  }

  root.PlanningPrompts = Object.freeze({ PROMPT_VERSION, STAGES, buildPlanningPrompt, packetCompleteness, expectedStageInputs });
  if (typeof module !== "undefined" && module.exports) module.exports = root.PlanningPrompts;
})();