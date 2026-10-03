const test = require("node:test");
const assert = require("node:assert/strict");

const Contracts = require("../platform/contracts.js");
const Protocol = require("../platform/companion-protocol.js");
const { CompanionRpcPeer } = require("../platform/companion-rpc.js");
const { createLoopbackCompanionPair } = require("../platform/companion-loopback.js");
const { FakeRuntimeControl } = require("./helpers/fake-runtime-control.js");
const { DesktopBridgeAgentRuntime } = require("../platform/desktop-bridge-runtime.js");
const { ExtensionCompanionEndpoint } = require("../platform/extension-companion-endpoint.js");
const { agentRuntimeConformance } = require("./contracts/conformance.js");

test("DesktopBridgeAgentRuntime controls an extension-side AgentRuntime through companion RPC", async () => {
  const pair = createLoopbackCompanionPair();
  const desktopRpc = new CompanionRpcPeer({ transport: pair.desktop });
  const extensionRpc = new CompanionRpcPeer({ transport: pair.extension });
  const remoteRuntime = new FakeRuntimeControl({
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
    assert.equal(runtime.getAgentLifecycle(worker.agentId).lifecycleState, "READY");
    assert.equal(runtime.isAgentReady(worker.agentId), true);

    const sent = await runtime.sendPrompt(worker.agentId, "perform task");
    assert.equal(sent.ok, true);
    assert.equal(remoteRuntime.prompts.at(-1).prompt, "perform task");
    assert.equal(runtime.getAgentLifecycle(worker.agentId).lifecycleState, "BUSY");
    assert.equal(runtime.isAgentBusy(worker.agentId), true);

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

test("DesktopBridgeAgentRuntime passes the reusable AgentRuntime lifecycle conformance", async () => {
  const pair = createLoopbackCompanionPair();
  const desktopRpc = new CompanionRpcPeer({ transport: pair.desktop });
  const extensionRpc = new CompanionRpcPeer({ transport: pair.extension });
  const remoteRuntime = new FakeRuntimeControl();
  const endpoint = new ExtensionCompanionEndpoint({ rpc: extensionRpc, agentRuntime: remoteRuntime });
  const runtime = new DesktopBridgeAgentRuntime({ rpc: desktopRpc });

  await endpoint.start();
  try {
    await agentRuntimeConformance(runtime);
  } finally {
    await runtime.close();
    await endpoint.stop();
  }
});

test("DesktopBridgeAgentRuntime demotes cached READY on transport loss and revalidates after reconnect", async () => {
  const pair = createLoopbackCompanionPair();
  const desktopRpc = new CompanionRpcPeer({ transport: pair.desktop });
  const extensionRpc = new CompanionRpcPeer({ transport: pair.extension });
  const remoteRuntime = new FakeRuntimeControl({
    agents: [{ agentId: "lead-transport", role: "lead", status: "IDLE", active: true, tabId: 51 }]
  });
  const endpoint = new ExtensionCompanionEndpoint({ rpc: extensionRpc, agentRuntime: remoteRuntime });
  const runtime = new DesktopBridgeAgentRuntime({ rpc: desktopRpc });
  const events = [];
  runtime.subscribeAgentEvents((event) => events.push(event));

  await endpoint.start();
  try {
    await runtime.load();
    assert.equal(runtime.isAgentReady("lead-transport"), true);

    await pair.extension.disconnect();
    assert.equal(runtime.getAgentLifecycle("lead-transport").lifecycleState, "UNAVAILABLE");
    assert.equal(runtime.getAgentLifecycle("lead-transport").lifecycleReason, "transport_disconnected");
    assert.equal(runtime.isAgentReady("lead-transport"), false);
    assert.equal(runtime.handshake, null);
    assert.ok(events.some((event) => event.type === "agent-lifecycle-changed"
      && event.agentId === "lead-transport"
      && event.state === "UNAVAILABLE"
      && event.reason === "transport_disconnected"));

    await pair.extension.connect();
    const ping = await runtime.pingAgent("lead-transport");
    assert.equal(ping.ok, true);
    assert.equal(runtime.getAgentLifecycle("lead-transport").lifecycleState, "READY");
    assert.equal(runtime.isAgentReady("lead-transport"), true);
  } finally {
    await runtime.close();
    await endpoint.stop();
  }
});

test("DesktopBridgeAgentRuntime fails cached agents closed on contract-version mismatch", async () => {
  const rpc = {
    transport: {
      getStatus() { return { connected: true }; }
    },
    onEvent() { return () => {}; },
    async start() { return { connected: true }; },
    async stop() {},
    async request(method) {
      if (method === "companion.handshake") {
        return {
          protocolVersion: Protocol.PROTOCOL_VERSION,
          contractVersion: Contracts.CONTRACT_VERSION - 1,
          role: "extension-companion"
        };
      }
      throw new Error(`unexpected_rpc_request:${method}`);
    }
  };
  const runtime = new DesktopBridgeAgentRuntime({ rpc });
  runtime.applySnapshot({
    runtimeStatus: "pool_active",
    updatedAt: Date.now(),
    agents: {
      "lead-incompatible": {
        agentId: "lead-incompatible",
        role: "lead",
        status: "IDLE",
        lifecycleState: "READY",
        lifecycleReason: "prompt_ready",
        lifecycleChangedAt: Date.now(),
        readinessCheckedAt: Date.now(),
        sessionId: "61"
      }
    }
  });

  await assert.rejects(runtime.pingAgent("lead-incompatible"), /companion_contract_version_mismatch/);
  assert.equal(runtime.getAgentLifecycle("lead-incompatible").lifecycleState, "FAILED");
  assert.equal(runtime.getAgentLifecycle("lead-incompatible").lifecycleReason, "runtime_incompatible");
  assert.equal(runtime.isAgentReady("lead-incompatible"), false);
});

test("DesktopBridgeAgentRuntime startup stays non-blocking until the browser companion connects", async () => {
  let releaseConnection;
  const connection = new Promise((resolve) => { releaseConnection = resolve; });
  const requests = [];
  const rpc = {
    transport: {
      waitForConnection() { return connection; }
    },
    async start() { return { connected: false }; },
    async request(method) {
      requests.push(method);
      if (method === "companion.handshake") {
        return {
          protocolVersion: Protocol.PROTOCOL_VERSION,
          contractVersion: Contracts.CONTRACT_VERSION,
          role: "extension-companion"
        };
      }
      if (method === "agent.snapshot") {
        return {
          runtimeStatus: "pool_active",
          updatedAt: 123,
          agents: {
            "lead-late": {
              agentId: "lead-late",
              role: "lead",
              status: "IDLE",
              lifecycleState: "READY",
              lifecycleReason: "prompt_ready",
              lifecycleChangedAt: 123,
              readinessCheckedAt: 123,
              sessionId: "41",
              chatUrl: "https://chatgpt.com/"
            }
          }
        };
      }
      if (method === "agent.getActiveSession") {
        return { id: "41", url: "https://chatgpt.com/", active: true };
      }
      throw new Error(`unexpected_rpc_request:${method}`);
    },
    onRequest() { return () => {}; },
    async stop() {}
  };
  const runtime = new DesktopBridgeAgentRuntime({ rpc });

  const startup = await Promise.race([
    runtime.load(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("desktop_bridge_startup_blocked")), 100))
  ]);

  assert.equal(startup.runtimeStatus, "idle");
  assert.equal(runtime.handshake, null);
  assert.deepEqual(requests, []);

  const activeSession = runtime.getActiveSession();
  assert.deepEqual(requests, []);
  releaseConnection({ connected: true });

  assert.deepEqual(await activeSession, { id: "41", url: "https://chatgpt.com/", active: true });
  assert.equal(runtime.handshake.role, "extension-companion");
  assert.equal(runtime.getAgent("lead-late").status, "IDLE");
  assert.deepEqual(requests, ["companion.handshake", "agent.snapshot", "agent.getActiveSession"]);

  await runtime.close();
});
