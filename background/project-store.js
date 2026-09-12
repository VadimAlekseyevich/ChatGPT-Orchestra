(() => {
  "use strict";

  const root = globalThis.ChatGPTOrchestra = globalThis.ChatGPTOrchestra || {};
  const STORAGE_KEY = "orchestra.projects.v1";
  const SCHEMA_VERSION = 1;

  function clone(value) {
    if (typeof structuredClone === "function") return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }

  function normalizeRepositoryUrl(value) {
    try {
      const url = new URL(String(value || "").trim());
      if (url.protocol !== "https:" || url.hostname !== "github.com") return null;
      const parts = url.pathname.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
      if (parts.length !== 2) return null;
      const owner = parts[0];
      const repo = parts[1].replace(/\.git$/i, "");
      if (!owner || !repo) return null;
      return { url: `https://github.com/${owner}/${repo}`, owner, repo, fullName: `${owner}/${repo}` };
    } catch (_) {
      return null;
    }
  }

  function defaultState() {
    return { schemaVersion: SCHEMA_VERSION, activeProjectId: null, projects: {}, updatedAt: 0 };
  }

  class ProjectStore {
    constructor({ storageArea = globalThis.chrome?.storage?.local, clock = () => Date.now(), idFactory = null } = {}) {
      this.storageArea = storageArea;
      this.clock = clock;
      this.idFactory = idFactory || (() => `proj-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`);
      this.state = defaultState();
      this.writeChain = Promise.resolve();
    }

    async load() {
      if (!this.storageArea?.get) return this.snapshot();
      const stored = await this.storageArea.get(STORAGE_KEY);
      const candidate = stored?.[STORAGE_KEY];
      if (candidate?.schemaVersion === SCHEMA_VERSION && candidate.projects && typeof candidate.projects === "object") {
        this.state = { ...defaultState(), ...candidate, projects: { ...candidate.projects } };
      }
      return this.snapshot();
    }

    snapshot() { return clone(this.state); }
    getProject(projectId) { return this.state.projects[projectId] ? clone(this.state.projects[projectId]) : null; }
    getActiveProject() { return this.state.activeProjectId ? this.getProject(this.state.activeProjectId) : null; }

    summary() {
      const project = this.getActiveProject();
      if (!project) return null;
      return {
        projectId: project.projectId,
        status: project.status,
        stage: project.stage,
        repository: project.repository,
        goal: project.initialGoal,
        currentRunId: project.currentRunId || null,
        taskCount: project.taskGraph?.tasks?.length || 0,
        validation: project.validation || null,
        updatedAt: project.updatedAt
      };
    }

    async persist() {
      this.state.updatedAt = this.clock();
      if (!this.storageArea?.set) return this.snapshot();
      const payload = clone(this.state);
      this.writeChain = this.writeChain.catch(() => {}).then(() => this.storageArea.set({ [STORAGE_KEY]: payload }));
      await this.writeChain;
      return this.snapshot();
    }

    async createProject({ goal, repositoryUrl }) {
      const normalizedGoal = String(goal || "").trim();
      const repository = normalizeRepositoryUrl(repositoryUrl);
      if (normalizedGoal.length < 10) return { ok: false, reason: "goal_too_short" };
      if (normalizedGoal.length > 12000) return { ok: false, reason: "goal_too_long" };
      if (!repository) return { ok: false, reason: "invalid_repository_url" };
      const active = this.getActiveProject();
      if (active && !["READY", "FAILED", "CANCELLED", "NEEDS_USER"].includes(active.status)) {
        return { ok: false, reason: "active_project_in_progress", projectId: active.projectId };
      }

      const now = this.clock();
      const projectId = this.idFactory();
      this.state.projects[projectId] = {
        schemaVersion: 1,
        projectId,
        status: "BOOTSTRAPPING",
        stage: "BOOTSTRAP",
        initialGoal: normalizedGoal,
        repository,
        artifacts: {},
        stageHistory: [],
        taskGraph: null,
        validation: null,
        currentRunId: null,
        createdAt: now,
        updatedAt: now
      };
      this.state.activeProjectId = projectId;
      await this.persist();
      return { ok: true, project: this.getProject(projectId) };
    }

    async beginStage(projectId, { stage, runId }) {
      const project = this.state.projects[projectId];
      if (!project) return null;
      project.status = "PLANNING";
      project.stage = stage;
      project.currentRunId = runId;
      project.stageHistory.push({ stage, runId, status: "started", at: this.clock() });
      project.updatedAt = this.clock();
      await this.persist();
      return this.getProject(projectId);
    }

    async completeStage(projectId, { stage, artifact }) {
      const project = this.state.projects[projectId];
      if (!project) return null;
      const runId = project.currentRunId;
      const alreadyCompleted = project.stageHistory.some((entry) => (
        entry.stage === stage && entry.runId === runId && entry.status === "completed"
      ));
      project.artifacts[stage] = clone(artifact);
      if (!alreadyCompleted) {
        project.stageHistory.push({ stage, runId, status: "completed", at: this.clock() });
      }
      project.updatedAt = this.clock();
      await this.persist();
      return this.getProject(projectId);
    }

    async setReady(projectId, taskGraph, validation) {
      const project = this.state.projects[projectId];
      if (!project) return null;
      project.taskGraph = clone(taskGraph);
      project.validation = clone(validation);
      project.status = "READY";
      project.stage = "READY";
      project.currentRunId = null;
      project.updatedAt = this.clock();
      await this.persist();
      return this.getProject(projectId);
    }

    async fail(projectId, reason, details = null, status = "NEEDS_USER") {
      const project = this.state.projects[projectId];
      if (!project) return null;
      project.status = status;
      project.lastError = { reason: String(reason || "planning_failed"), details: clone(details), at: this.clock() };
      project.updatedAt = this.clock();
      await this.persist();
      return this.getProject(projectId);
    }
  }

  root.ProjectStore = ProjectStore;
  root.PROJECT_STORE_STORAGE_KEY = STORAGE_KEY;
  root.normalizeRepositoryUrl = normalizeRepositoryUrl;
  if (typeof module !== "undefined" && module.exports) module.exports = { ProjectStore, STORAGE_KEY, normalizeRepositoryUrl };
})();