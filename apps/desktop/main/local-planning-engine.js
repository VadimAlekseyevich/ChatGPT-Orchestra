"use strict";

const LOCAL_VERIFICATION_PLANNING_INSTRUCTION = [
  "DESKTOP LOCAL VERIFICATION CONTRACT:",
  "- For every code/mutating task without verificationWaiver, include localVerification as an array of structured command objects.",
  "- Each object shape is {command: executable, args: [argv...], optional timeoutMs, optional label}.",
  "- command is an executable name/path only. args are separate argv strings. Never put &&, ||, pipes, redirects, command substitution or shell scripts into command/args as a way to combine commands.",
  "- Do not include shell, env or environment fields. Orchestra executes with shell:false and a sanitized environment only after explicit repository trust.",
  "- Convert simple discovered commands such as `npm test` into {\"command\":\"npm\",\"args\":[\"test\"]}. Split multiple checks into multiple command objects.",
  "- If no safe local command can be specified, provide a concrete verificationWaiver instead of inventing an executable.",
  "- The DAG critic must reject or correct missing/unsafe localVerification for code tasks."
].join("\n");

function augmentPlanningPrompt(prompt, project) {
  if (!project?.repositoryRuntime?.repositoryId) return prompt;
  const text = String(prompt || "");
  if (!/planning stage (DECOMPOSE|DAG_CRITIC)\b/i.test(text)) return prompt;
  if (text.includes("DESKTOP LOCAL VERIFICATION CONTRACT:")) return prompt;
  return `${text}\n\n${LOCAL_VERIFICATION_PLANNING_INSTRUCTION}`;
}

function createLocalPlanningEngine(BasePlanningEngine) {
  if (typeof BasePlanningEngine !== "function") throw new TypeError("base_planning_engine_required");
  return class LocalPlanningEngine extends BasePlanningEngine {
    constructor(options = {}) {
      const originalSendPrompt = options.sendPrompt;
      const projectStore = options.projectStore;
      super({
        ...options,
        ...(typeof originalSendPrompt === "function" ? {
          sendPrompt: (agentId, prompt, sendOptions) => originalSendPrompt(
            agentId,
            augmentPlanningPrompt(prompt, projectStore?.getActiveProject?.()),
            sendOptions
          )
        } : {})
      });
    }

    async startProject({ goal, repositoryUrl, repositoryId = null } = {}) {
      const lead = this.getLead();
      if (!this.isConnected(lead)) return { ok: false, reason: "lead_not_connected" };
      const created = await this.projectStore.createProject({ goal, repositoryUrl, repositoryId });
      if (!created.ok) return created;
      return this.dispatchStage(created.project.projectId, "DISCOVERY");
    }
  };
}

module.exports = { createLocalPlanningEngine, augmentPlanningPrompt, LOCAL_VERIFICATION_PLANNING_INSTRUCTION };
