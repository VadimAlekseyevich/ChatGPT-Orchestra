const test = require("node:test");
const assert = require("node:assert/strict");

const { FakeAgentRuntime } = require("../platform/fake-runtime.js");

test("FakeAgentRuntime emits portable lifecycle events without duplicate no-op transitions", async () => {
  let now = 1000;
  const runtime = new FakeAgentRuntime({ clock: () => now, readinessTtlMs: 100 });
  const events = [];
  runtime.subscribeAgentEvents((event) => events.push(event));

  const session = await runtime.createSession({ url: "https://chatgpt.com/", active: true });
  const worker = await runtime.createAgentForSession({ role: "worker", session, status: "CONNECTING" });
  assert.equal(runtime.getAgentLifecycle(worker.agentId).lifecycleState, "UNAVAILABLE");

  now = 1010;
  const ping = await runtime.pingAgent(worker.agentId);
  assert.equal(ping.ok, true);
  assert.equal(runtime.isAgentReady(worker.agentId), true);

  const lifecycleEventsAfterFirstPing = events.filter((event) => event.type === "agent-lifecycle-changed").length;
  now = 1020;
  await runtime.pingAgent(worker.agentId);
  assert.equal(events.filter((event) => event.type === "agent-lifecycle-changed").length, lifecycleEventsAfterFirstPing);

  now = 1030;
  const sent = await runtime.sendPrompt(worker.agentId, "work");
  assert.equal(sent.ok, true);
  assert.equal(runtime.getAgentLifecycle(worker.agentId).lifecycleState, "BUSY");

  now = 1040;
  const stopped = await runtime.stopAgent(worker.agentId);
  assert.equal(stopped.ok, true);
  assert.equal(runtime.getAgentLifecycle(worker.agentId).lifecycleState, "READY");

  const sequence = events
    .filter((event) => event.type === "agent-lifecycle-changed")
    .map((event) => [event.previousState, event.state, event.reason]);
  assert.deepEqual(sequence, [
    ["UNAVAILABLE", "READY", "prompt_ready"],
    ["READY", "BUSY", "prompt_active"],
    ["BUSY", "READY", "prompt_ready"]
  ]);
});

test("stale READY cannot dispatch until the runtime performs a fresh readiness check", async () => {
  let now = 2000;
  const runtime = new FakeAgentRuntime({ clock: () => now, readinessTtlMs: 50 });
  const session = await runtime.createSession({ url: "https://chatgpt.com/" });
  const worker = await runtime.createAgentForSession({ role: "worker", session, status: "CONNECTING" });
  await runtime.pingAgent(worker.agentId);
  assert.equal(runtime.isAgentReady(worker.agentId), true);

  now = 2100;
  assert.equal(runtime.isAgentReady(worker.agentId), false);
  const stale = await runtime.sendPrompt(worker.agentId, "must not dispatch");
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, "agent_not_ready");
  assert.equal(runtime.prompts.length, 0);

  await runtime.pingAgent(worker.agentId);
  const fresh = await runtime.sendPrompt(worker.agentId, "dispatch now");
  assert.equal(fresh.ok, true);
  assert.equal(runtime.prompts.length, 1);
});

test("terminal FAILED does not recover from ordinary ping or heartbeat", async () => {
  let now = 3000;
  const runtime = new FakeAgentRuntime({ clock: () => now });
  const session = await runtime.createSession({ url: "https://chatgpt.com/" });
  const worker = await runtime.createAgentForSession({ role: "worker", session, status: "CONNECTING" });

  await runtime.setAgentLifecycle(worker.agentId, "FAILED", {
    reason: "runtime_failure",
    details: { terminal: true }
  });
  assert.equal(runtime.getAgentLifecycle(worker.agentId).lifecycleState, "FAILED");

  now = 3010;
  const ping = await runtime.pingAgent(worker.agentId);
  assert.equal(ping.ok, false);
  assert.equal(runtime.getAgentLifecycle(worker.agentId).lifecycleState, "FAILED");

  await runtime.updateHeartbeat(session.id, { availability: "ready", generating: false });
  assert.equal(runtime.getAgentLifecycle(worker.agentId).lifecycleState, "FAILED");
  assert.equal(runtime.isAgentReady(worker.agentId), false);
});
