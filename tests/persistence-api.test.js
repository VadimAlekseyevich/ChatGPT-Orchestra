const test = require("node:test");
const assert = require("node:assert/strict");

require("../content/message-types.js");
require("../persistence/portable-state.js");
require("../persistence/project-bundle.js");
require("../context/context-packets.js");
const { OrchestratorApi, API_VERSION } = require("../background/orchestrator-api.js");

function apiWith({ recoveryStatus = "PAUSED", importResult = { ok: true, projectId: "P1" } } = {}) {
  const calls = [];
  const projectBundleService = {
    async exportBundle(options) { calls.push(["export", options]); return { ok: true, serialized: "{}", filename: "bundle.json" }; },
    async importBundle(bundle, options) { calls.push(["import", bundle, options]); return importResult; }
  };
  const recoveryController = { getPublicState: () => ({ status: recoveryStatus }) };
  return { api: new OrchestratorApi({ projectBundleService, recoveryController, persistenceInfo: { backend: "test" } }), calls };
}

test("Orchestrator API v4 preserves persistence metadata and bundle export", async () => {
  const { api, calls } = apiWith();
  assert.equal(API_VERSION, 4);
  const info = await api.query("persistence");
  assert.equal(info.ok, true);
  assert.equal(info.persistence.backend, "test");
  assert.equal(info.persistence.portableSchemaVersion, 1);
  assert.equal(info.persistence.contextPacketVersion, 1);
  const exported = await api.execute("exportProjectBundle", { projectId: "P1" });
  assert.equal(exported.ok, true);
  assert.deepEqual(calls[0], ["export", { projectId: "P1" }]);
});

test("live RUNNING recovery state blocks import before storage mutation", async () => {
  const { api, calls } = apiWith({ recoveryStatus: "RUNNING" });
  const result = await api.execute("importProjectBundle", { bundle: { fake: true } });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "portable_import_requires_safe_recovery_state");
  assert.equal(calls.length, 0);
});

test("safe import returns reloadRequired and requests a post-import write freeze", async () => {
  const { api, calls } = apiWith({ recoveryStatus: "STOPPED" });
  const result = await api.execute("importProjectBundle", { bundle: "bundle", replace: true });
  assert.equal(result.ok, true);
  assert.equal(result.reloadRequired, true);
  assert.deepEqual(calls[0], ["import", "bundle", { replace: true, freezeAfter: true }]);
});