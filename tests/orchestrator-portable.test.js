const test = require("node:test");
const assert = require("node:assert/strict");

require("../content/message-types.js");
require("../platform/contracts.js");
const { FakeAgentRuntime } = require("../platform/fake-runtime.js");
const { FakeAgentPool } = require("../platform/fake-agent-pool.js");
const { ServiceWorkerOrchestrator } = require("../background/orchestrator.js");

test("ServiceWorkerOrchestrator manages logical agents through FakeAgentRuntime with no browser globals", async () => {
  const previousChrome = globalThis.chrome;
  try {
    delete globalThis.chrome;
    const runtime = new FakeAgentRuntime({
      agents: [{ agentId: "lead-1", role: "lead", status: "IDLE" }]
    });
    const agentPool = new FakeAgentPool({ runtime });
    const orchestrator = new ServiceWorkerOrchestrator({ agentRuntime: runtime, agentPool, logger: { warn() {} } });
    await orchestrator.init();

    const lead = await orchestrator.registerActiveLead();
    assert.equal(lead.ok, true);
    assert.equal(lead.agent.agentId, "lead-1");

    const workers = await orchestrator.createWorkers(2);
    assert.equal(workers.ok, true);
    assert.equal(workers.created.length, 2);
    assert.equal(runtime.listAgents().filter((agent) => agent.role === "worker").length, 2);

    const target = workers.created[0];
    assert.equal((await runtime.pingAgent(target)).ok, true);
    assert.equal(runtime.isAgentReady(target), true);
    assert.equal((await orchestrator.sendPromptToAgent(target, "portable task")).ok, true);
    assert.deepEqual(runtime.prompts.at(-1), { agentId: target, prompt: "portable task" });

    const serialized = JSON.stringify(orchestrator.getPublicState());
    assert.equal(serialized.includes("sessionId"), false);
    assert.equal(serialized.includes("tabId"), false);
  } finally {
    if (previousChrome !== undefined) globalThis.chrome = previousChrome;
  }
});

test("portable sender identity forbids admin commands from agent runtimes", async () => {
  const runtime = new FakeAgentRuntime({ agents: [{ agentId: "worker-1", role: "worker", status: "IDLE" }] });
  const agentPool = new FakeAgentPool({ runtime });
  const orchestrator = new ServiceWorkerOrchestrator({ agentRuntime: runtime, agentPool, logger: { warn() {} } });
  await orchestrator.init();

  const result = await orchestrator.handleRuntimeMessage(
    { type: globalThis.ChatGPTOrchestra.MESSAGE_TYPES.ORCHESTRATOR_CREATE_WORKERS, payload: { count: 2 } },
    { agentId: "worker-1", runtimeKind: "fake", bindingPresent: true }
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "orchestrator_command_forbidden_from_agent");

  const unregisteredBinding = await orchestrator.handleRuntimeMessage(
    { type: globalThis.ChatGPTOrchestra.MESSAGE_TYPES.ORCHESTRATOR_CREATE_WORKERS, payload: { count: 2 } },
    { agentId: null, runtimeKind: "test-adapter", bindingPresent: true }
  );
  assert.equal(unregisteredBinding.ok, false);
  assert.equal(unregisteredBinding.reason, "orchestrator_command_forbidden_from_agent");
});
