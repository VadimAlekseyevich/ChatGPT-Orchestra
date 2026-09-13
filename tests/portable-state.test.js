const test = require("node:test");
const assert = require("node:assert/strict");

const { MemoryStateStore } = require("../platform/fake-runtime.js");
const { TransactionalStateStore } = require("../platform/transactional-state-store.js");
const { MigrationRegistry } = require("../persistence/migration-registry.js");
const { PortableStateManager, STORE_KEYS, BACKUP_KEY, PORTABLE_SCHEMA_VERSION } = require("../persistence/portable-state.js");

function seed(projectId = "P1") {
  return {
    [STORE_KEYS.projects]: {
      schemaVersion: 1,
      activeProjectId: projectId,
      projects: {
        [projectId]: {
          projectId,
          status: "RUNNING",
          repository: { url: "https://github.com/example/repo", owner: "example", repo: "repo" },
          initialGoal: { text: "portable test" },
          planning: { apiKey: "sk-123456789012345678901234567890" }
        },
        OTHER: { projectId: "OTHER", initialGoal: { text: "must not export" } }
      }
    },
    [STORE_KEYS.scheduler]: {
      schemaVersion: 1,
      projectId,
      status: "RUNNING",
      tasks: { T1: { id: "T1", status: "APPROVED" } },
      runs: { R1: { runId: "R1", taskId: "T1", agentId: "worker-1", status: "DONE", tabId: 77 } },
      decisions: [{ type: "task_assigned", taskId: "T1" }]
    },
    [STORE_KEYS.reviews]: { schemaVersion: 1, projectId, reviews: { V1: { reviewId: "V1", taskId: "T1", reviewerAgentId: "worker-2", sessionId: "review-session" } } },
    [STORE_KEYS.integration]: { schemaVersion: 1, projectId, status: "READY", runs: { I1: { runId: "I1", legacyTabId: 88 } } },
    [STORE_KEYS.recovery]: {
      schemaVersion: 1,
      projectId,
      status: "RUNNING",
      snapshot: { agents: [{ agentId: "worker-1", tabId: 42, sessionId: "42" }] }
    },
    [STORE_KEYS.events]: {
      schemaVersion: 1,
      eventCursor: 2,
      processedEvents: {
        E1: { projectId, taskId: "T1", runId: "R1", agentId: "worker-1", cursor: 1 },
        E2: { projectId: "OTHER", taskId: "X", runId: "RX", agentId: "other", cursor: 2 }
      },
      processedOrder: ["E1", "E2"],
      sequences: { [`${projectId}:T1:R1:worker-1`]: 1, "OTHER:X:RX:other": 1 },
      events: [
        { cursor: 1, tabId: 42, runtimeSource: { sessionId: "42", agentId: "worker-1" }, source: { runtime: { sessionId: "42" } }, event: { projectId, taskId: "T1", runId: "R1", agentId: "worker-1" } },
        { cursor: 2, tabId: 99, event: { projectId: "OTHER", taskId: "X", runId: "RX", agentId: "other" } }
      ],
      rejections: [
        { reason: "project_rejection", event: { projectId, taskId: "T1", runId: "R1", agentId: "worker-1" }, tabId: 42 },
        { reason: "other_project_rejection", event: { projectId: "OTHER", taskId: "X", runId: "RX", agentId: "other" }, tabId: 99 },
        { reason: "unscoped_runtime_diagnostic", details: { sessionId: "sensitive-session" } }
      ]
    },
    [STORE_KEYS.agents]: {
      schemaVersion: 1,
      runtimeStatus: "pool_active",
      agents: { "worker-1": { agentId: "worker-1", role: "worker", tabId: 42, sessionId: "42", chatUrl: "https://chatgpt.com/c/test" } }
    }
  };
}

function manager(initial = {}, clock = () => 1000) {
  const store = new TransactionalStateStore({ store: new MemoryStateStore(initial) });
  const migrations = new MigrationRegistry({ currentVersion: PORTABLE_SCHEMA_VERSION });
  return { store, portable: new PortableStateManager({ stateStore: store, migrations, clock }) };
}

test("portable capture scopes one project, redacts secrets and strips browser runtime bindings", async () => {
  const { portable } = manager(seed());
  const result = await portable.capture();
  assert.equal(result.ok, true);
  assert.equal(result.snapshot.projectId, "P1");
  assert.deepEqual(Object.keys(result.snapshot.namespaces.projects.projects), ["P1"]);
  assert.equal(result.snapshot.namespaces.projects.projects.P1.planning.apiKey, "[REDACTED]");
  assert.equal(result.snapshot.namespaces.events.events.length, 1);
  assert.deepEqual(Object.keys(result.snapshot.namespaces.events.processedEvents), ["E1"]);
  assert.equal(result.snapshot.namespaces.events.rejections.length, 1);
  assert.equal(result.snapshot.namespaces.events.rejections[0].reason, "project_rejection");
  assert.deepEqual(result.snapshot.namespaces.agents.agents, {});
  const serialized = JSON.stringify(result.snapshot);
  assert.equal(serialized.includes("\"tabId\""), false);
  assert.equal(serialized.includes("\"legacyTabId\""), false);
  assert.equal(serialized.includes("\"sessionId\""), false);
  assert.equal(serialized.includes("sk-123456789012345678901234567890"), false);
  assert.equal(serialized.includes("unscoped_runtime_diagnostic"), false);
});

test("portable import creates backup, restores logical state and forces recovery gate", async () => {
  const source = manager(seed());
  const captured = await source.portable.capture();
  assert.equal(captured.ok, true);

  const target = manager({});
  const imported = await target.portable.import(captured.snapshot);
  assert.equal(imported.ok, true);
  assert.equal(imported.recoveryRequired, true);

  const restored = await target.store.get([...Object.values(STORE_KEYS), BACKUP_KEY]);
  assert.equal(restored[STORE_KEYS.projects].activeProjectId, "P1");
  assert.equal(restored[STORE_KEYS.scheduler].tasks.T1.status, "APPROVED");
  assert.equal(restored[STORE_KEYS.reviews].reviews.V1.taskId, "T1");
  assert.equal(restored[STORE_KEYS.integration].projectId, "P1");
  assert.equal(restored[STORE_KEYS.recovery].status, "RECOVERY_REQUIRED");
  assert.equal(restored[STORE_KEYS.recovery].reason, "portable_import_reconciliation_required");
  assert.deepEqual(restored[STORE_KEYS.agents].agents, {});
  assert.equal(restored[STORE_KEYS.events].events[0].tabId, undefined);
  assert.equal(restored[BACKUP_KEY].length, 1);
});

test("portable validation rejects namespace project identity mismatch", async () => {
  const source = manager(seed());
  const captured = await source.portable.capture();
  assert.equal(captured.ok, true);
  captured.snapshot.namespaces.scheduler.projectId = "OTHER";
  const checked = source.portable.validate(captured.snapshot);
  assert.equal(checked.ok, false);
  assert.equal(checked.reason, "portable_namespace_project_mismatch");
  assert.equal(checked.namespace, "scheduler");
});

test("portable import strips injected runtime bindings before persistence", async () => {
  const source = manager(seed());
  const captured = await source.portable.capture();
  captured.snapshot.namespaces.scheduler.runs.R1.tabId = 999;
  captured.snapshot.namespaces.reviews.reviews.V1.sessionId = "injected";
  const target = manager({});
  const imported = await target.portable.import(captured.snapshot);
  assert.equal(imported.ok, true);
  const restored = await target.store.get([STORE_KEYS.scheduler, STORE_KEYS.reviews]);
  assert.equal(restored[STORE_KEYS.scheduler].runs.R1.tabId, undefined);
  assert.equal(restored[STORE_KEYS.reviews].reviews.V1.sessionId, undefined);
});

test("portable import refuses to overwrite a different active project unless replace is explicit", async () => {
  const source = manager(seed("P1"));
  const captured = await source.portable.capture();
  const target = manager(seed("P2"));
  const refused = await target.portable.import(captured.snapshot);
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, "portable_destination_has_active_project");
  const replaced = await target.portable.import(captured.snapshot, { replace: true });
  assert.equal(replaced.ok, true);
  assert.equal((await target.store.get(STORE_KEYS.projects))[STORE_KEYS.projects].activeProjectId, "P1");
});
