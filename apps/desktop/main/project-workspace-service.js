"use strict";

const CATALOG_KEY = "orchestra.desktop.project-catalog.v1";
const CATALOG_VERSION = 1;
const SAFE_PROJECT_CHANGE_STATES = new Set(["IDLE", "PAUSED", "STOPPED", "RECOVERY_REQUIRED"]);

function clone(value) {
  if (value === undefined) return undefined;
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function projectMetadata(project, { active = false, archivedAt = null } = {}) {
  if (!project?.projectId) return null;
  return {
    projectId: String(project.projectId),
    status: String(project.status || "UNKNOWN"),
    stage: String(project.stage || project.status || "UNKNOWN"),
    goal: String(project.initialGoal || project.goal || ""),
    repository: project.repository ? clone(project.repository) : null,
    createdAt: Number(project.createdAt) || 0,
    updatedAt: Number(project.updatedAt) || 0,
    archivedAt: archivedAt === null ? null : Number(archivedAt) || 0,
    active: Boolean(active)
  };
}

function defaultCatalog() {
  return { schemaVersion: CATALOG_VERSION, projects: {}, updatedAt: 0 };
}

class DesktopProjectWorkspaceService {
  constructor({
    stateStore,
    portableStateManager,
    projectStore,
    recoveryController,
    portableStateKeys = [],
    clock = () => Date.now()
  } = {}) {
    if (!stateStore?.get || !stateStore?.set || !stateStore?.transaction) throw new TypeError("project_workspace_state_store_required");
    if (!portableStateManager?.capture || !portableStateManager?.import) throw new TypeError("project_workspace_portable_state_required");
    if (!projectStore?.getActiveProject) throw new TypeError("project_workspace_project_store_required");
    this.stateStore = stateStore;
    this.portableStateManager = portableStateManager;
    this.projectStore = projectStore;
    this.recoveryController = recoveryController || null;
    this.portableStateKeys = [...new Set((portableStateKeys || []).map(String).filter(Boolean))];
    this.clock = clock;
  }

  async loadCatalog() {
    const stored = await this.stateStore.get(CATALOG_KEY);
    const candidate = stored?.[CATALOG_KEY];
    if (!candidate || candidate.schemaVersion !== CATALOG_VERSION || !candidate.projects || typeof candidate.projects !== "object") {
      return defaultCatalog();
    }
    return {
      ...defaultCatalog(),
      ...clone(candidate),
      projects: { ...(candidate.projects || {}) }
    };
  }

  async saveCatalog(catalog) {
    const next = {
      ...defaultCatalog(),
      ...clone(catalog || {}),
      schemaVersion: CATALOG_VERSION,
      projects: { ...(catalog?.projects || {}) },
      updatedAt: this.clock()
    };
    await this.stateStore.set({ [CATALOG_KEY]: next });
    return clone(next);
  }

  recoveryStatus() {
    return String(this.recoveryController?.getPublicState?.()?.status || "IDLE");
  }

  changeAllowed() {
    const recovery = this.recoveryController?.getPublicState?.() || { status: "IDLE", safePoint: { reached: true } };
    const status = String(recovery.status || "IDLE");
    if (!SAFE_PROJECT_CHANGE_STATES.has(status)) return false;
    if (status === "IDLE") return true;
    return recovery.safePoint?.reached === true;
  }

  async archiveCurrent() {
    const active = this.projectStore.getActiveProject();
    if (!active?.projectId) return { ok: true, archived: false, projectId: null };
    const captured = await this.portableStateManager.capture({ projectId: active.projectId });
    if (!captured?.ok) return captured || { ok: false, reason: "project_snapshot_capture_failed" };
    const catalog = await this.loadCatalog();
    const archivedAt = this.clock();
    catalog.projects[active.projectId] = {
      projectId: active.projectId,
      metadata: projectMetadata(active, { archivedAt }),
      snapshot: clone(captured.snapshot),
      archivedAt
    };
    await this.saveCatalog(catalog);
    return { ok: true, archived: true, projectId: active.projectId };
  }

  async listProjects() {
    const catalog = await this.loadCatalog();
    const active = this.projectStore.getActiveProject();
    const items = new Map();
    for (const slot of Object.values(catalog.projects || {})) {
      if (!slot?.projectId || !slot?.metadata) continue;
      items.set(String(slot.projectId), { ...clone(slot.metadata), active: false, restorable: Boolean(slot.snapshot) });
    }
    if (active?.projectId) {
      items.set(String(active.projectId), {
        ...projectMetadata(active, { active: true }),
        restorable: true
      });
    }
    const projects = [...items.values()].sort((a, b) =>
      Number(b.active) - Number(a.active)
      || Number(b.updatedAt || b.archivedAt || 0) - Number(a.updatedAt || a.archivedAt || 0)
    );
    return {
      ok: true,
      activeProjectId: active?.projectId || null,
      recoveryStatus: this.recoveryStatus(),
      canChangeProject: this.changeAllowed(),
      projects
    };
  }

  async prepareNewProject() {
    const active = this.projectStore.getActiveProject();
    if (active && !this.changeAllowed()) {
      return { ok: false, reason: "project_change_requires_safe_state", recoveryStatus: this.recoveryStatus() };
    }
    const archived = await this.archiveCurrent();
    if (!archived?.ok) return archived;
    if (!this.portableStateKeys.length) return { ok: false, reason: "portable_state_keys_missing" };
    await this.stateStore.transaction(async (tx) => {
      await tx.remove(this.portableStateKeys);
    });
    return { ok: true, reloadRequired: true, archivedProjectId: archived.projectId || null };
  }

  async switchProject(projectId) {
    const targetId = String(projectId || "").trim();
    if (!targetId) return { ok: false, reason: "project_id_missing" };
    const active = this.projectStore.getActiveProject();
    if (active?.projectId === targetId) return { ok: true, projectId: targetId, reloadRequired: false, alreadyActive: true };
    if (active && !this.changeAllowed()) {
      return { ok: false, reason: "project_change_requires_safe_state", recoveryStatus: this.recoveryStatus() };
    }

    const catalogBefore = await this.loadCatalog();
    if (!catalogBefore.projects?.[targetId]?.snapshot) return { ok: false, reason: "project_slot_not_found", projectId: targetId };

    const archived = await this.archiveCurrent();
    if (!archived?.ok) return archived;

    const catalog = await this.loadCatalog();
    const slot = catalog.projects?.[targetId];
    if (!slot?.snapshot) return { ok: false, reason: "project_slot_not_found", projectId: targetId };
    const imported = await this.portableStateManager.import(slot.snapshot, { replace: true, freezeAfter: true });
    if (!imported?.ok) return imported || { ok: false, reason: "project_slot_restore_failed", projectId: targetId };
    return {
      ok: true,
      projectId: targetId,
      reloadRequired: true,
      recoveryRequired: imported.recoveryRequired !== false,
      backupId: imported.backupId || null,
      archivedProjectId: archived.projectId || null
    };
  }
}

module.exports = {
  DesktopProjectWorkspaceService,
  CATALOG_KEY,
  CATALOG_VERSION,
  SAFE_PROJECT_CHANGE_STATES,
  projectMetadata
};
