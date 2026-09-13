(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};
  const Contracts = root.PlatformContracts || (typeof require === "function" ? require("./contracts.js") : null);

  function clone(value) {
    if (typeof structuredClone === "function") return structuredClone(value);
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }

  class FakeGitWorkspace {
    constructor({ baseSha = "b".repeat(40), targetBranch = "main" } = {}) {
      this.baseSha = baseSha;
      this.targetBranch = targetBranch;
      this.repository = null;
      this.workspaces = new Map();
      this.commits = [];
    }

    async loadRepository(repository) {
      this.repository = clone(repository || {});
      return { ok: true, repository: clone(this.repository) };
    }

    async snapshotBase() {
      return { ok: true, targetBranch: this.targetBranch, baseSha: this.baseSha };
    }

    async createTaskWorkspace({ projectId, taskId, runId, startSha = null } = {}) {
      const workspaceId = `task:${projectId}:${taskId}:${runId}`;
      const workspace = { workspaceId, kind: "task", projectId, taskId, runId, startSha: startSha || this.baseSha, changedFiles: [] };
      this.workspaces.set(workspaceId, workspace);
      return clone(workspace);
    }

    async createIntegrationWorkspace({ projectId, runId, startSha = null } = {}) {
      const workspaceId = `integration:${projectId}:${runId}`;
      const workspace = { workspaceId, kind: "integration", projectId, runId, startSha: startSha || this.baseSha, changedFiles: [] };
      this.workspaces.set(workspaceId, workspace);
      return clone(workspace);
    }

    async status(workspaceId) {
      const workspace = this.workspaces.get(workspaceId);
      return workspace ? { ok: true, workspace: clone(workspace), clean: workspace.changedFiles.length === 0 } : { ok: false, reason: "workspace_missing" };
    }

    async diff(workspaceId) {
      const workspace = this.workspaces.get(workspaceId);
      return workspace ? { ok: true, changedFiles: [...workspace.changedFiles] } : { ok: false, reason: "workspace_missing" };
    }

    async validateScope(workspaceId, scope = {}) {
      const workspace = this.workspaces.get(workspaceId);
      if (!workspace) return { ok: false, reason: "workspace_missing" };
      const allow = Array.isArray(scope.allow) ? scope.allow : [];
      const violations = allow.length ? workspace.changedFiles.filter((file) => !allow.some((prefix) => file.startsWith(String(prefix).replace(/\*.*$/, "")))) : [];
      return { ok: violations.length === 0, violations };
    }

    async runVerification(workspaceId, commands = []) {
      if (!this.workspaces.has(workspaceId)) return { ok: false, reason: "workspace_missing" };
      return { ok: true, commands: [...commands], results: commands.map((command) => ({ command, exitCode: 0 })) };
    }

    async commit(workspaceId, { message = "test commit" } = {}) {
      if (!this.workspaces.has(workspaceId)) return { ok: false, reason: "workspace_missing" };
      const sha = String(this.commits.length + 1).padStart(40, "0");
      const record = { workspaceId, sha, message };
      this.commits.push(record);
      return { ok: true, ...clone(record) };
    }

    async cleanup(workspaceId) {
      return this.workspaces.delete(workspaceId);
    }

    setChangedFiles(workspaceId, files = []) {
      const workspace = this.workspaces.get(workspaceId);
      if (!workspace) return false;
      workspace.changedFiles = [...files];
      return true;
    }
  }

  root.FakeGitWorkspace = FakeGitWorkspace;
  if (typeof module !== "undefined" && module.exports) module.exports = { FakeGitWorkspace };
})();
