const test = require("node:test");
const assert = require("node:assert/strict");

const Contracts = require("../platform/contracts.js");
const Protocol = require("../platform/companion-protocol.js");
const { NativeMessagingTransport } = require("../platform/native-messaging-transport.js");

function eventHook() {
  const listeners = new Set();
  return {
    addListener(listener) { listeners.add(listener); },
    removeListener(listener) { listeners.delete(listener); },
    emit(value) { for (const listener of [...listeners]) listener(value); }
  };
}

test("NativeMessagingTransport satisfies CompanionTransport over chrome.runtime.connectNative", async () => {
  const onMessage = eventHook();
  const onDisconnect = eventHook();
  const posted = [];
  const port = {
    onMessage,
    onDisconnect,
    postMessage(value) { posted.push(value); },
    disconnect() {}
  };
  const chromeApi = { runtime: { connectNative: (name) => {
    assert.equal(name, "com.chatgptorchestra.companion");
    return port;
  } } };

  const transport = new NativeMessagingTransport({ chromeApi });
  Contracts.assertCompanionTransport(transport);
  let received = null;
  transport.subscribe((frame) => { received = frame; });

  await transport.connect();
  assert.equal(transport.getStatus().connected, true);
  await transport.send(Protocol.event("e1", "bridge.ready", { ok: true }));
  assert.equal(posted.length, 1);

  onMessage.emit(Protocol.event("e2", "bridge.peer", { ok: true }));
  assert.equal(received.event, "bridge.peer");

  onDisconnect.emit();
  assert.equal(transport.getStatus().connected, false);
});