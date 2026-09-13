const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

require("../platform/contracts.js");
require("../platform/companion-protocol.js");
const { CompanionRpcPeer } = require("../platform/companion-rpc.js");
const { createLoopbackCompanionPair } = require("../platform/companion-loopback.js");
const { FakeAgentRuntime, MemoryStateStore, DeterministicTimerRuntime } = require("../platform/fake-runtime.js");
const { TransactionalStateStore } = require("../platform/transactional-state-store.js");
const { DesktopBridgeAgentRuntime } = require("../platform/desktop-bridge-runtime.js");
const { ExtensionCompanionEndpoint } = require("../platform/extension-companion-endpoint.js");
const { CompanionDesktopHost } = require("../apps/desktop/main/companion-desktop-host.js");

function silentLogger() { return { info() {}, warn() {}, error() {}, log() {} }; }

test("CompanionDesktopHost receives browser events while desktop owns Core/state", async () => {
  const pair = createLoopbackCompanionPair();
  const desktopRpc = new CompanionRpcPeer({ transport: pair.desktop });
  const extensionRpc = new CompanionRpcPeer({ transport: pair.extension });
  const remoteRuntime = new FakeAgentRuntime({
    agents: [{ agentId: "lead-bridge", role: "lead", status: "IDLE", active: true, tabId: 71 }]
  });
  const endpoint = new ExtensionCompanionEndpoint({ rpc: extensionRpc, agentRuntime: remoteRuntime });
  const bridgeRuntime = new DesktopBridgeAgentRuntime({ rpc: desktopRpc });
  const stateStore = new TransactionalStateStore({ store: new MemoryStateStore() });
  const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-companion-host-"));
  const host = new CompanionDesktopHost({
    dataDirectory,
    stateStore,
    agentRuntime: bridgeRuntime,
    timerRuntime: new DeterministicTimerRuntime(),
    logger: silentLogger()
  });

  await endpoint.start();
  try {
    await host.init();
    const lead = bridgeRuntime.getAgent("lead-bridge");
    assert.equal(lead.role, "lead");
    assert.equal(lead.status, "IDLE");

    const result = await endpoint.forwardRuntimeMessage({
      type: host.root.MESSAGE_TYPES.CONTENT_HEARTBEAT,
      payload: { availability: "ready", generating: false }
    }, { sessionId: bridgeRuntime.sessionIdForAgent(lead) });
    assert.equal(result.ok, true);

    const dashboard = await host.query("dashboard");
    assert.equal(dashboard.ok, true);
    assert.equal(dashboard.dashboard.persistence.backend, "injected");
    assert.equal(dashboard.dashboard.agents.some((agent) => agent.agentId === "lead-bridge" && agent.connected), true);

    const events = await host.query("events", { limit: 20 });
    assert.equal(events.ok, true);
  } finally {
    await host.close();
    await endpoint.stop();
  }
});
