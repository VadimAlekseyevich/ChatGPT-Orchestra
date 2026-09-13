const test = require("node:test");
const assert = require("node:assert/strict");

const Contracts = require("../platform/contracts.js");
const { ExtensionAgentRuntime } = require("../platform/extension-runtime.js");
const { MemoryStateStore, FakeAgentRuntime, DeterministicTimerRuntime } = require("../platform/fake-runtime.js");

function assertStateStoreConformance(store) {
  return (async () => {
    Contracts.assertStateStore(store);
    await store.set({ alpha: { value: 1 }, beta: 2 });
    assert.deepEqual((await store.get("alpha")).alpha, { value: 1 });
    assert.equal((await store.get("beta")).beta, 2);
  })();
}

test("MemoryStateStore satisfies portable StateStore contract", async () => {
  await assertStateStoreConformance(new MemoryStateStore());
});

test("FakeAgentRuntime satisfies AgentRuntime contract without Chrome globals", async () => {
  const previousChrome = globalThis.chrome;
  try {
    delete globalThis.chrome;
    const runtime = new FakeAgentRuntime({
      agents: [
        { agentId: "lead-1", role: "lead", status: "IDLE", active: true },
        { agentId: "worker-1", role: "worker", status: "IDLE" }
      ]
    });
    Contracts.assertAgentRuntime(runtime);
    await runtime.load();
    assert.equal(runtime.isAgentConnected("lead-1"), true);
    assert.equal((await runtime.sendPrompt("worker-1", "task")).ok, true);
    assert.deepEqual(runtime.prompts, [{ agentId: "worker-1", prompt: "task" }]);
    await runtime.setProtocolContext("worker-1", { projectId: "P1", taskId: "T1", runId: "R1" });
    assert.equal(runtime.getAgent("worker-1").protocolContext.runId, "R1");
    await runtime.clearProtocolContext("worker-1");
    assert.equal(runtime.getAgent("worker-1").protocolContext, null);
  } finally {
    if (previousChrome !== undefined) globalThis.chrome = previousChrome;
  }
});

test("runtime connectivity is distinct from agent health", () => {
  const fakeRuntime = new FakeAgentRuntime({
    agents: [{ agentId: "worker-error", role: "worker", status: "ERROR", sessionId: "session-error" }]
  });
  assert.equal(fakeRuntime.isAgentConnected("worker-error"), true);
  fakeRuntime.agents.get("worker-error").status = "OFFLINE";
  assert.equal(fakeRuntime.isAgentConnected("worker-error"), false);

  const records = new Map([
    ["worker-error", { agentId: "worker-error", role: "worker", status: "ERROR", tabId: 42 }],
    ["worker-offline", { agentId: "worker-offline", role: "worker", status: "OFFLINE", tabId: 43 }]
  ]);
  const extensionRuntime = new ExtensionAgentRuntime({
    chromeApi: {},
    registry: { getAgent: (agentId) => records.get(agentId) || null }
  });
  assert.equal(extensionRuntime.isAgentConnected("worker-error"), true);
  assert.equal(extensionRuntime.isAgentConnected("worker-offline"), false);
});

test("DeterministicTimerRuntime satisfies TimerRuntime and fires only on demand", async () => {
  const timer = new DeterministicTimerRuntime();
  Contracts.assertTimerRuntime(timer);
  let count = 0;
  timer.scheduleRecurring("watchdog", { periodMinutes: 1 }, () => { count += 1; });
  assert.equal(count, 0);
  assert.equal(await timer.fire("watchdog"), true);
  assert.equal(count, 1);
  await timer.cancel("watchdog");
  assert.equal(await timer.fire("watchdog"), false);
  assert.equal(count, 1);
});

test("contract assertions fail closed for partial implementations", () => {
  assert.throws(() => Contracts.assertAgentRuntime({ sendPrompt() {} }), /agent_runtime_contract_missing/);
  assert.throws(() => Contracts.assertStateStore({ get() {} }), /state_store_contract_missing/);
  assert.throws(() => Contracts.assertTimerRuntime({ cancel() {} }), /timer_runtime_contract_missing/);
});
