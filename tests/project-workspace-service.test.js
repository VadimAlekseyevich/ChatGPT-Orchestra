"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DesktopProjectWorkspaceService,
  CATALOG_KEY
} = require("../apps/desktop/main/project-workspace-service.js");

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function fakeStateStore(initial = {}) {
  const data = clone(initial);
  return {
    data,
    async get(selector = null) {
      if (typeof selector === "string") return { [selector]: clone(data[selector]) };
      if (Array.isArray(selector)) return Object.fromEntries(selector.map((key) => [key, clone(data[key])]));
      return clone(data);
    },
    async set(values) { Object.assign(data, clone(values || {})); },
    async transaction(callback) {
      return callback({
        get: async (selector = null) => {
          if (typeof selector === "string") return { [selector]: clone(data[selector]) };
          if (Array.isArray(selector)) return Object.fromEntries(selector.map((key) => [key, clone(data[key])]));
          return clone(data);
        },
        set: async (values) => Object.assign(data, clone(values || {})),
        remove: async (keys) => {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
        }
      });
    }
  };
}

function project(id, status = "PLANNING") {
  return {
    projectId: id,
    status,
    stage: status === "PLANNING" ? "PLAN_V1" : status,
    initialGoal: `Goal for ${id} with enough detail`,
    repository: { url: `https://github.com/acme/${id.toLowerCase()}`, fullName: `acme/${id.toLowerCase()}` },
    createdAt: 10,
    updatedAt: 20
  };
}

test("project catalog lists the live project together with archived slots", async () => {
  const stateStore = fakeStateStore({
    [CATALOG_KEY]: {
      schemaVersion: 1,
      projects: {
        P1: {
          projectId: "P1",
          metadata: {
            projectId: "P1",
            status: "STOPPED",
            stage: "EXECUTION",
            goal: "Archived goal",
            repository: { fullName: "acme/p1" },
            updatedAt: 5
          },
          snapshot: { schemaVersion: 1, projectId: "P1", namespaces: {} },
          archivedAt: 6
        }
      },
      updatedAt: 6
    }
  });
  const service = new DesktopProjectWorkspaceService({
    stateStore,
    portableStateManager: { async capture() { return { ok: true, snapshot: {} }; }, async import() { return { ok: true }; } },
    projectStore: { getActiveProject: () => project("P2") },
    recoveryController: { getPublicState: () => ({ status: "RECOVERY_REQUIRED" }) },
    portableStateKeys: ["a"]
  });

  const result = await service.listProjects();
  assert.equal(result.ok, true);
  assert.equal(result.activeProjectId, "P2");
  assert.equal(result.projects.length, 2);
  assert.equal(result.projects[0].projectId, "P2");
  assert.equal(result.projects[0].active, true);
  assert.equal(result.projects[1].projectId, "P1");
  assert.equal(result.projects[1].restorable, true);
});

test("prepareNewProject archives current state and removes only portable namespaces", async () => {
  const stateStore = fakeStateStore({
    portableA: { value: 1 },
    portableB: { value: 2 },
    repositoryRegistry: { keep: true }
  });
  const active = project("P1", "READY");
  const service = new DesktopProjectWorkspaceService({
    stateStore,
    portableStateManager: {
      async capture({ projectId }) {
        assert.equal(projectId, "P1");
        return { ok: true, snapshot: { schemaVersion: 1, projectId: "P1", namespaces: { marker: "P1" } } };
      },
      async import() { throw new Error("unexpected_import"); }
    },
    projectStore: { getActiveProject: () => active },
    recoveryController: { getPublicState: () => ({ status: "STOPPED" }) },
    portableStateKeys: ["portableA", "portableB"],
    clock: () => 100
  });

  const result = await service.prepareNewProject();
  assert.equal(result.ok, true);
  assert.equal(result.reloadRequired, true);
  assert.equal(result.archivedProjectId, "P1");
  assert.equal(stateStore.data.portableA, undefined);
  assert.equal(stateStore.data.portableB, undefined);
  assert.deepEqual(stateStore.data.repositoryRegistry, { keep: true });
  assert.equal(stateStore.data[CATALOG_KEY].projects.P1.snapshot.projectId, "P1");
});

test("switchProject archives the current project and restores the target slot through portable import", async () => {
  const targetSnapshot = { schemaVersion: 1, projectId: "P1", namespaces: { marker: "old" } };
  const stateStore = fakeStateStore({
    [CATALOG_KEY]: {
      schemaVersion: 1,
      projects: {
        P1: {
          projectId: "P1",
          metadata: {
            projectId: "P1",
            status: "STOPPED",
            stage: "EXECUTION",
            goal: "Old project",
            repository: { fullName: "acme/p1" },
            updatedAt: 5
          },
          snapshot: targetSnapshot,
          archivedAt: 6
        }
      },
      updatedAt: 6
    }
  });
  const imports = [];
  const service = new DesktopProjectWorkspaceService({
    stateStore,
    portableStateManager: {
      async capture({ projectId }) {
        assert.equal(projectId, "P2");
        return { ok: true, snapshot: { schemaVersion: 1, projectId: "P2", namespaces: { marker: "current" } } };
      },
      async import(snapshot, options) {
        imports.push({ snapshot: clone(snapshot), options: clone(options) });
        return { ok: true, recoveryRequired: true, backupId: "B1" };
      }
    },
    projectStore: { getActiveProject: () => project("P2", "READY") },
    recoveryController: { getPublicState: () => ({ status: "PAUSED" }) },
    portableStateKeys: ["a"],
    clock: () => 100
  });

  const result = await service.switchProject("P1");
  assert.equal(result.ok, true);
  assert.equal(result.projectId, "P1");
  assert.equal(result.reloadRequired, true);
  assert.equal(result.archivedProjectId, "P2");
  assert.deepEqual(imports, [{ snapshot: targetSnapshot, options: { replace: true, freezeAfter: true } }]);
  assert.equal(stateStore.data[CATALOG_KEY].projects.P2.snapshot.projectId, "P2");
});

test("project changes fail closed while runtime work is active", async () => {
  const stateStore = fakeStateStore({
    [CATALOG_KEY]: {
      schemaVersion: 1,
      projects: {
        P1: {
          projectId: "P1",
          metadata: { projectId: "P1", status: "STOPPED", stage: "STOPPED", goal: "Old", repository: null },
          snapshot: { schemaVersion: 1, projectId: "P1", namespaces: {} },
          archivedAt: 1
        }
      }
    }
  });
  const service = new DesktopProjectWorkspaceService({
    stateStore,
    portableStateManager: { async capture() { throw new Error("must_not_capture"); }, async import() { throw new Error("must_not_import"); } },
    projectStore: { getActiveProject: () => project("P2", "RUNNING") },
    recoveryController: { getPublicState: () => ({ status: "RUNNING" }) },
    portableStateKeys: ["a"]
  });

  const result = await service.switchProject("P1");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "project_change_requires_safe_state");
  assert.equal(result.recoveryStatus, "RUNNING");
});
