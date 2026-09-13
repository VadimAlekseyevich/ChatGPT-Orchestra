const test = require("node:test");
const assert = require("node:assert/strict");

const { FakeAgentRuntime } = require("../platform/fake-runtime.js");
const { createLoopbackCompanionPair } = require("../platform/companion-loopback.js");
const { CompanionRpcPeer } = require("../platform/companion-rpc.js");
const { ExtensionCompanionEndpoint } = require("../platform/extension-companion-endpoint.js");
const { DesktopBridgeAgentRuntime } = require("../platform/desktop-bridge-runtime.js");

async function createFixture() {
  const pair = createLoopbackCompanionPair();
  const desktopRpc = new CompanionRpcPeer({ transport: pair.desktop, requestTimeoutMs: 1000 });
  const extensionRpc = new CompanionRpcPeer({ transport: pair.extension, requestTimeoutMs: 1000 });
  const extensionRuntime = new FakeAgentRuntime({
    agents: [{ agentId: "lead-1", role: "lead", status: "IDLE", sessionId: "42" }]
  });
  const extensionEndpoint = new ExtensionCompanionEndpoint({ rpc: extensionRpc, agentRuntime: extensionRuntime });
  const desktopRuntime = new DesktopBridgeAgentRuntime({ rpc: desktopRpc });
  const apiCalls = [];

  desktopRuntime.bindHostHandlers({
    onApiMessage: async (message, sender) => {
      apiCalls.push({ message, sender });
      return { apiVersion: 4, ok: true, echoed: message.payload };
    }
  });

  await extensionEndpoint.start();
  await desktopRuntime.load();
  return { extensionEndpoint, desktopRuntime, apiCalls };
}

test("extension UI message reaches desktop Orchestrator API handler over companion RPC", async () => {
  const fixture = await createFixture();
  try {
    const message = {
      type: "orchestra/api-query",
      payload: { name: "state", payload: { compact: true } }
    };
    const result = await fixture.extensionEndpoint.forwardApiMessage(message, {});

    assert.equal(result.ok, true);
    assert.deepEqual(result.echoed, message.payload);
    assert.equal(fixture.apiCalls.length, 1);
    assert.equal(fixture.apiCalls[0].sender.kind, "test-ui");
    assert.equal(fixture.apiCalls[0].sender.sessionId, null);
  } finally {
    await fixture.desktopRuntime.close();
    await fixture.extensionEndpoint.stop();
  }
});

test("agent runtime messages and UI API messages use distinct RPC methods", async () => {
  const fixture = await createFixture();
  try {
    await fixture.extensionEndpoint.forwardApiMessage({ type: "orchestra/api-query", payload: { name: "agents" } }, {});
    assert.equal(fixture.apiCalls.length, 1);
    assert.equal(fixture.apiCalls[0].sender.agentId, null);
  } finally {
    await fixture.desktopRuntime.close();
    await fixture.extensionEndpoint.stop();
  }
});
