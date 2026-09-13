"use strict";

const { GitCliWorkspace } = require("./git-cli-workspace.js");

function safeRemote(value) {
  const remote = String(value || "origin").trim();
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(remote)) throw new Error("git_remote_invalid");
  return remote;
}

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

  async mergeTaskArtifact(integrationWorkspaceId, taskCommit, options = {}) {
    const record = this.workspaceRecord(integrationWorkspaceId);
    if (record.kind !== "integration") throw new Error("git_merge_requires_integration_workspace");
    const status = await super.status(integrationWorkspaceId);
    if (!status.clean) throw new Error("git_integration_workspace_dirty");
    const commit = await this.verifyStartSha(taskCommit);

    try {
      await this.execGit(["merge-base", "--is-ancestor", commit, "HEAD"], { cwd: record.path });
      return { ok: true, alreadyIntegrated: true, workspaceId: integrationWorkspaceId, taskCommit: commit, head: status.head };
    } catch {}

    const message = String(options.message || `Integrate task artifact ${commit.slice(0, 12)}`).trim();
    if (!message || /\0/.test(message)) throw new Error("git_merge_message_invalid");
    await this.execGit([
      "-c",
      `core.hooksPath=${this.hooksDirectory}`,
      "merge",
      "--no-ff",
      "--no-edit",
      "--no-gpg-sign",
      "-m",
      message,
      commit
    ], { cwd: record.path });
    const { stdout: head } = await this.execGit(["rev-parse", "HEAD"], { cwd: record.path });
    const { stdout: parents } = await this.execGit(["rev-list", "--parents", "-n", "1", "HEAD"], { cwd: record.path });
    const parentShas = parents.trim().split(/\s+/).slice(1);
    if (parentShas.length < 2) throw new Error("git_integration_merge_not_no_ff");
    return {
      ok: true,
      alreadyIntegrated: false,
      workspaceId: integrationWorkspaceId,
      taskCommit: commit,
      head: head.trim(),
      parents: parentShas
    };
  }

  async push(workspaceId, options = {}) {
    const record = this.workspaceRecord(workspaceId);
    if (options.validated !== true) throw new Error("git_push_requires_local_validation");
    const status = await super.status(workspaceId);
    if (!status.clean) throw new Error("git_push_requires_clean_workspace");
    const remote = safeRemote(options.remote || "origin");
    const branch = String(options.branch || record.branch || "").trim();
    if (branch !== record.branch || !branch.startsWith(`orchestra/${this.projectId}/`)) throw new Error("git_push_branch_not_allowed");
    const { stdout, stderr } = await this.execGit(["push", "--porcelain", remote, `${branch}:${branch}`], { cwd: record.path });
    return { ok: true, workspaceId, remote, branch, stdout, stderr };
  }

  async cleanup(workspaceId, options = {}) {
    await super.cleanup(workspaceId, options);
    return true;
  }
}

module.exports = { SystemGitWorkspace, safeRemote };
