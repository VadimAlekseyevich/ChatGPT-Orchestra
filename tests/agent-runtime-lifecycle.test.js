const test = require("node:test");
const assert = require("node:assert/strict");

const { FakeAgentRuntime } = require("../platform/fake-runtime.js");

test("FakeAgentRuntime emits portable lifecycle events without duplicate no-op transitions", async () => {
  let now = 1000;
  const runtime = new FakeAgentRuntime({ clock: () => now, readinessTtlMs: 100 });
  const events = [];
  runtime.subscribeAgentEvents((event) => events.push(event));

  const worker = runtime.addAgent({ role: "worker", status: "CONNECTING" });
  assert.equal(runtime.getAgentLifecycle(worker.agentId).lifecycleState, "UNAVAILABLE");

  now = 1010;
  const refreshed = await runtime.refreshAgent(worker.agentId);
  assert.equal(refreshed.ok, true);
  assert.equal(runtime.isAgentReady(worker.agentId), true);

  const afterFirstRefresh = events.filter((event) => event.type === "agent-lifecycle-changed").length;
  now = 1020;
  await runtime.refreshAgent(worker.agentId);
  assert.equal(events.filter((event) => event.type === "agent-lifecycle-changed").length, afterFirstRefresh);

  now = 1030;
  assert.equal((await runtime.sendPrompt(worker.agentId, "work")).ok, true);
  assert.equal(runtime.getAgentLifecycle(worker.agentId).lifecycleState, "BUSY");

  now = 1040;
  assert.equal((await runtime.stopAgent(worker.agentId)).ok, true);
  assert.equal(runtime.getAgentLifecycle(worker.agentId).lifecycleState, "READY");

  assert.deepEqual(events.filter((event) => event.type === "agent-lifecycle-changed").map((event) => [event.previousState, event.state, event.reason]), [
    ["UNAVAILABLE", "READY", "prompt_ready"],
    ["READY", "BUSY", "prompt_active"],
    ["BUSY", "READY", "prompt_ready"]
  ]);
});

test("stale READY cannot dispatch until the runtime performs a fresh readiness check", async () => {
  let now = 2000;
  const runtime = new FakeAgentRuntime({ clock: () => now, readinessTtlMs: 50 });
  const worker = runtime.addAgent({ role: "worker", status: "CONNECTING" });
  await runtime.refreshAgent(worker.agentId);
  assert.equal(runtime.isAgentReady(worker.agentId), true);

  now = 2100;
  assert.equal(runtime.isAgentReady(worker.agentId), false);
  const stale = await runtime.sendPrompt(worker.agentId, "must not dispatch");
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, "agent_not_ready");
  assert.equal(runtime.prompts.length, 0);

  await runtime.refreshAgent(worker.agentId);
  assert.equal((await runtime.sendPrompt(worker.agentId, "dispatch now")).ok, true);
  assert.equal(runtime.prompts.length, 1);
});

test("terminal FAILED does not recover from ordinary refresh and requires explicit recovery", async () => {
  let now = 3000;
  const runtime = new FakeAgentRuntime({ clock: () => now });
  const worker = runtime.addAgent({ role: "worker", status: "CONNECTING" });

  runtime.transitionAgent(worker.agentId, "FAILED", { reason: "runtime_failure", details: { terminal: true } });
  assert.equal(runtime.getAgentLifecycle(worker.agentId).lifecycleState, "FAILED");

  now = 3010;
  const refreshed = await runtime.refreshAgent(worker.agentId);
  assert.equal(refreshed.ok, false);
  assert.equal(runtime.getAgentLifecycle(worker.agentId).lifecycleState, "FAILED");
  assert.equal(runtime.isAgentReady(worker.agentId), false);

  const recovered = await runtime.openAgent({ agentId: worker.agentId, role: "worker" });
  assert.equal(recovered.ok, true);
  assert.equal(runtime.getAgentLifecycle(worker.agentId).lifecycleState, "READY");
});
