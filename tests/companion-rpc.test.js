const test = require("node:test");
const assert = require("node:assert/strict");

require("../platform/contracts.js");
require("../platform/companion-protocol.js");
const { CompanionRpcPeer } = require("../platform/companion-rpc.js");
const { createLoopbackCompanionPair } = require("../platform/companion-loopback.js");

test("companion RPC is bidirectional and transports only protocol DTOs", async () => {
  const pair = createLoopbackCompanionPair();
  const desktop = new CompanionRpcPeer({ transport: pair.desktop });
  const extension = new CompanionRpcPeer({ transport: pair.extension });

  desktop.onRequest("desktop.echo", ({ value }) => ({ value, side: "desktop" }));
  extension.onRequest("extension.echo", ({ value }) => ({ value, side: "extension" }));

  await Promise.all([desktop.start(), extension.start()]);
  try {
    assert.deepEqual(await desktop.request("extension.echo", { value: 7 }), { value: 7, side: "extension" });
    assert.deepEqual(await extension.request("desktop.echo", { value: 9 }), { value: 9, side: "desktop" });

    let observed = null;
    const off = desktop.onEvent((name, payload) => { observed = { name, payload }; });
    await extension.notify("bridge.status", { connected: true });
    await new Promise((resolve) => setImmediate(resolve));
    off();
    assert.deepEqual(observed, { name: "bridge.status", payload: { connected: true } });
  } finally {
    await Promise.all([desktop.stop(), extension.stop()]);
  }
});

test("companion RPC fails closed for unknown methods", async () => {
  const pair = createLoopbackCompanionPair();
  const desktop = new CompanionRpcPeer({ transport: pair.desktop });
  const extension = new CompanionRpcPeer({ transport: pair.extension });
  await Promise.all([desktop.start(), extension.start()]);
  try {
    await assert.rejects(() => desktop.request("missing.method"), /missing\.method/);
  } finally {
    await Promise.all([desktop.stop(), extension.stop()]);
  }
});