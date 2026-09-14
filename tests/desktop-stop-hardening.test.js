const test = require("node:test");
const assert = require("node:assert/strict");

const { ManagedBrowserDesktopHost } = require("../apps/desktop/main/managed-browser-desktop-host.js");

function hostDouble({ runs = [] } = {}) {
  const order = [];
  const cancelled = [];
  const host = Object.create(ManagedBrowserDesktopHost.prototype);
  host.initialized = true;
  host.repositoryService = {
    listActiveVerificationRuns() { return { ok: true, runs }; },
    async cancelVerification(payload) {
      order.push(`cancel:${payload.runId}`);
      cancelled.push(payload);
      return { ok: true, runId: payload.runId };
    }
  };
  host.logger = { info() {}, warn() {}, error() {} };
  host.orchestratorApi = {
    async execute(command) {
      order.push(`core:${command}`);
      return { ok: true, command };
    }
  };
  host.recoveryController = { async tick() { order.push("recovery:tick"); return { ok: true }; } };
  return { host, order, cancelled };
}

test("Stop Now cancels active local verification before the Core stop transition", async () => {
  const { host, order, cancelled } = hostDouble({
    runs: [
      { runId: "verify-1", projectId: "P1", repositoryId: "R1" },
      { runId: "verify-2", projectId: "P1", repositoryId: "R1" }
    ]
  });

  const result = await host.execute("stopNow", {});
  assert.equal(result.ok, true);
  assert.deepEqual(order, ["cancel:verify-1", "cancel:verify-2", "core:stopNow", "recovery:tick"]);
  assert.deepEqual(cancelled, [
    { runId: "verify-1", projectId: "P1", repositoryId: "R1" },
    { runId: "verify-2", projectId: "P1", repositoryId: "R1" }
  ]);
  assert.deepEqual(result.localVerificationCancellation, {
    ok: true,
    requested: 2,
    cancelled: 2,
    failed: 0,
    runs: [
      { runId: "verify-1", ok: true, reason: null },
      { runId: "verify-2", ok: true, reason: null }
    ]
  });
});

test("Stop Now still enters the Core stop boundary when one local cancellation fails", async () => {
  const { host, order } = hostDouble({
    runs: [{ runId: "verify-fail", projectId: "P1", repositoryId: "R1" }]
  });
  host.repositoryService.cancelVerification = async (payload) => {
    order.push(`cancel:${payload.runId}`);
    return { ok: false, reason: "verification_cancel_failed", runId: payload.runId };
  };

  const result = await host.execute("stopNow", {});
  assert.equal(result.ok, true);
  assert.deepEqual(order, ["cancel:verify-fail", "core:stopNow", "recovery:tick"]);
  assert.equal(result.localVerificationCancellation.ok, false);
  assert.equal(result.localVerificationCancellation.failed, 1);
});
