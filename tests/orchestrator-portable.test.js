const test = require("node:test");
const assert = require("node:assert/strict");

require("../content/message-types.js");
require("../platform/contracts.js");
const { FakeAgentRuntime } = require("../platform/fake-runtime.js");
require("../background/tab-registry.js");
const { ServiceWorkerOrchestrator } = require("../background/orchestrator.js");

test("ServiceWorkerOrchestrator manages agents through FakeAgentRuntime with no Chrome global", async () => {
  const previousChrome = globalThis.chrome;
  try {
    delete globalThis.chrome;
    const runtime = new FakeAgentRuntime({
      agents: [{ agentId: "lead-1", role: "lead", status: "IDLE", active: true, chatUrl: "https://chatgpt.com/c/lead" }]
    });
    const orchestrator = new ServiceWorkerOrchestrator({ agentRuntime: runtime, logger: { warn() {} } });
    await orchestrator.init();

    const lead = await orchestrator.registerActiveLead();
    assert.equal(lead.ok, true);
    assert.equal(lead.agent.agentId, "lead-1");

    const workers = await orchestrator.createWorkers(2);
    assert.equal(workers.ok, true);
    assert.equal(workers.created.length, 2);
    assert.equal(runtime.listAgents().filter((agent) => agent.role === "worker").length, 2);

    const target = workers.created[0];
    assert.equal((await orchestrator.sendPromptToAgent(target, "portable task")).ok, true);
    assert.deepEqual(runtime.prompts.at(-1), { agentId: target, prompt: "portable task" });
  } finally {
    if (previousChrome !== undefined) globalThis.chrome = previousChrome;
  }
});

test("portable sender context still forbids admin commands from agent sessions", async () => {
  const runtime = new FakeAgentRuntime({ agents: [{ agentId: "worker-1", role: "worker", status: "IDLE" }] });
  const orchestrator = new ServiceWorkerOrchestrator({ agentRuntime: runtime, logger: { warn() {} } });
  await orchestrator.init();
  const sender = runtime.normalizeSender({ agentId: "worker-1" });
  const result = await orchestrator.handleRuntimeMessage(
    { type: globalThis.ChatGPTOrchestra.MESSAGE_TYPES.ORCHESTRATOR_CREATE_WORKERS, payload: { count: 2 } },
    sender
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "orchestrator_command_forbidden_from_agent_session");
});
