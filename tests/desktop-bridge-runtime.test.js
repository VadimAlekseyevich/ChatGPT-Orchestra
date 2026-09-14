const test = require("node:test");
const assert = require("node:assert/strict");

const Contracts = require("../platform/contracts.js");
require("../platform/companion-protocol.js");
const { CompanionRpcPeer } = require("../platform/companion-rpc.js");
const { createLoopbackCompanionPair } = require("../platform/companion-loopback.js");
const { FakeAgentRuntime } = require("../platform/fake-runtime.js");
const { DesktopBridgeAgentRuntime } = require("../platform/desktop-bridge-runtime.js");
const { ExtensionCompanionEndpoint } = require("../platform/extension-companion-endpoint.js");

test("DesktopBridgeAgentRuntime controls an extension-side AgentRuntime through companion RPC", async () => {
  const pair = createLoopbackCompanionPair();
  const desktopRpc = new CompanionRpcPeer({ transport: pair.desktop });
  const extensionRpc = new CompanionRpcPeer({ transport: pair.extension });
  const remoteRuntime = new FakeAgentRuntime({
    agents: [{ agentId: "lead-1", role: "lead", status: "IDLE", active: true, tabId: 41 }]
  });
  const endpoint = new ExtensionCompanionEndpoint({ rpc: extensionRpc, agentRuntime: remoteRuntime });
  const runtime = new DesktopBridgeAgentRuntime({ rpc: desktopRpc });

  await endpoint.start();
  try {
    await runtime.load();
    Contracts.assertAgentRuntime(runtime);
    assert.equal(runtime.handshake.role, "extension-companion");
    assert.equal(runtime.getAgent("lead-1").role, "lead");

    const session = await runtime.createSession({ url: "https://chatgpt.com/", active: false });
    const worker = await runtime.createAgentForSession({ role: "worker", session, label: "Worker 1", status: "CONNECTING" });
    assert.equal(runtime.sessionIdForAgent(worker.agentId), session.id);

    const ping = await runtime.pingAgent(worker.agentId);
    assert.equal(ping.ok, true);
    assert.equal(runtime.getAgent(worker.agentId).status, "IDLE");

    const sent = await runtime.sendPrompt(worker.agentId, "perform task");
    assert.equal(sent.ok, true);
    assert.equal(remoteRuntime.prompts.at(-1).prompt, "perform task");

    runtime.bindHostHandlers({
      onRuntimeMessage: async (message, sender) => ({ ok: true, echo: message.type, agentId: sender.agentId })
    });
    const forwarded = await endpoint.forwardRuntimeMessage({ type: "CONTENT_HEARTBEAT" }, { sessionId: session.id });
    assert.equal(forwarded.ok, true);
    assert.equal(forwarded.echo, "CONTENT_HEARTBEAT");
    assert.equal(forwarded.agentId, worker.agentId);
  } finally {
    await runtime.close();
    await endpoint.stop();
  }
});