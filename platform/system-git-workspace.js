"use strict";

const { GitCliWorkspace } = require("./git-cli-workspace.js");

class SystemGitWorkspace extends GitCliWorkspace {
  async loadRepository(input) {
    let request = input;
    if (input && typeof input === "object" && input.url && !input.path && !input.sourceUrl && !input.mode) {
      request = { ...input, mode: "clone", sourceUrl: input.url };
    }
    const repository = await super.loadRepository(request);
    return { ok: true, repository };
  }

  async snapshotBase(ref = "HEAD") {
    const base = await super.snapshotBase(ref);
    return {
      ok: true,
      repositoryId: base.repositoryId,
      baseSha: base.sha,
      sha: base.sha,
      targetBranch: base.branch,
      branch: base.branch,
      changedFiles: base.changedFiles
    };
  }

  async createTaskWorkspace(input = {}) {
    if (!input || typeof input !== "object") throw new Error("task_workspace_request_invalid");
    if (input.projectId && String(input.projectId) !== this.projectId) throw new Error("workspace_project_mismatch");
    return super.createTaskWorkspace(input.taskId, input.runId, input.startSha || "HEAD");
  }

  async createIntegrationWorkspace(input = {}) {
    if (!input || typeof input !== "object") throw new Error("integration_workspace_request_invalid");
    if (input.projectId && String(input.projectId) !== this.projectId) throw new Error("workspace_project_mismatch");
    return super.createIntegrationWorkspace(input.runId, input.startSha || "HEAD");
  }

  async status(workspaceId) {
    return { ok: true, ...(await super.status(workspaceId)) };
  }

  async diff(workspaceId) {
    return { ok: true, ...(await super.diff(workspaceId)) };
  }

  async validateScope(workspaceId, scope = {}) {
    const allow = Array.isArray(scope) ? scope : (Array.isArray(scope?.allow) ? scope.allow : []);
    return super.validateScope(workspaceId, allow);
  }

  async runVerification(workspaceId, verification = {}) {
    if (Array.isArray(verification)) {
      if (verification.some((entry) => !entry || typeof entry !== "object" || Array.isArray(entry))) {
        throw new Error("verification_command_requires_argv");
      }
      const results = [];
      for (const entry of verification) results.push(await super.runVerification(workspaceId, entry));
      return { ok: results.every((item) => item.ok === true), results };
    }
    return super.runVerification(workspaceId, verification);
  }

  async commit(workspaceId, options = {}) {
    const message = typeof options === "string" ? options : options?.message;
    const result = await super.commit(workspaceId, message);
    if (result?.ok) return { ...result, sha: result.head };
    return result;
  }

  async cleanup(workspaceId, options = {}) {
    await super.cleanup(workspaceId, options);
    return true;
  }
}

module.exports = { SystemGitWorkspace };
