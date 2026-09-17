const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const {
  ElectronPreloadChatGPTPageAdapter,
  COMMAND_CHANNEL,
  RESPONSE_CHANNEL
} = require("../apps/desktop/main/electron-preload-chatgpt-page-adapter.js");

class FakeIpcMain extends EventEmitter {}

function webContents(id, onSend, onInput = null) {
  return {
    id,
    send(channel, message) {
      assert.equal(channel, COMMAND_CHANNEL);
      onSend?.(message);
    },
    ...(onInput ? { sendInputEvent(event) { onInput(event); } } : {})
  };
}

function respond(ipcMain, senderId, requestId, result) {
  ipcMain.emit(RESPONSE_CHANNEL, { sender: { id: senderId } }, { requestId, result });
}

test("preload page adapter sends only allowlisted structured commands with shared selectors", async () => {
  const ipcMain = new FakeIpcMain();
  const seen = [];
  const adapter = new ElectronPreloadChatGPTPageAdapter({ ipcMain, requestTimeoutMs: 1000 });
  const contents = webContents(41, (message) => {
    seen.push(message);
    queueMicrotask(() => respond(ipcMain, 41, message.requestId, { ok: true, availability: "ready", generating: false, composerOccupied: false, url: "https://chatgpt.com/" }));
  });
  const ping = await adapter.ping(contents);
  assert.equal(ping.ok, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].name, "status");
  assert.ok(Array.isArray(seen[0].selectors.composers));
  assert.ok(Array.isArray(seen[0].selectors.assistantMessages));
  adapter.close();
});

test("page adapter rejects a response from the wrong BrowserWindow sender", async () => {
  const ipcMain = new FakeIpcMain();
  const warnings = [];
  const adapter = new ElectronPreloadChatGPTPageAdapter({ ipcMain, requestTimeoutMs: 1000, logger: { warn(...args) { warnings.push(args); } } });
  const contents = webContents(7, (message) => {
    queueMicrotask(() => {
      respond(ipcMain, 8, message.requestId, { ok: true, availability: "ready" });
      respond(ipcMain, 7, message.requestId, { ok: true, availability: "ready" });
    });
  });
  const result = await adapter.ping(contents);
  assert.equal(result.ok, true);
  assert.equal(warnings.length, 1);
  adapter.close();
});

test("send and stop operations cross the preload boundary without exposing IPC to the remote page", async () => {
  const ipcMain = new FakeIpcMain();
  const calls = [];
  const adapter = new ElectronPreloadChatGPTPageAdapter({ ipcMain, requestTimeoutMs: 1000 });
  const contents = webContents(55, (message) => {
    calls.push(message);
    const result = message.name === "send-prompt"
      ? { ok: true, accepted: true, confirmed: true, method: "button-click", url: "https://chatgpt.com/c/1" }
      : { ok: true, stopped: true, url: "https://chatgpt.com/c/1" };
    queueMicrotask(() => respond(ipcMain, 55, message.requestId, result));
  });
  assert.equal((await adapter.sendPrompt(contents, "hello")).accepted, true);
  assert.equal((await adapter.stopGeneration(contents)).stopped, true);
  assert.equal(calls[0].name, "send-prompt");
  assert.equal(calls[0].payload.prompt, "hello");
  assert.equal(calls[1].name, "stop-generation");
  adapter.close();
});

test("staged prompt falls back to trusted Enter and must be confirmed before success", async () => {
  const ipcMain = new FakeIpcMain();
  const calls = [];
  const inputs = [];
  const adapter = new ElectronPreloadChatGPTPageAdapter({ ipcMain, requestTimeoutMs: 1000 });
  const contents = webContents(56, (message) => {
    calls.push(message.name);
    const result = message.name === "send-prompt"
      ? { ok: false, reason: "send_not_confirmed", promptStaged: true, url: "https://chatgpt.com/c/1" }
      : { ok: true, availability: "generating", generating: true, composerOccupied: false, url: "https://chatgpt.com/c/1" };
    queueMicrotask(() => respond(ipcMain, 56, message.requestId, result));
  }, (event) => inputs.push(event));

  const result = await adapter.sendPrompt(contents, "planning prompt");
  assert.equal(result.ok, true);
  assert.equal(result.accepted, true);
  assert.equal(result.confirmed, true);
  assert.equal(result.method, "trusted-enter");
  assert.deepEqual(inputs, [
    { type: "keyDown", keyCode: "Enter" },
    { type: "keyUp", keyCode: "Enter" }
  ]);
  assert.deepEqual(calls, ["send-prompt", "status"]);
  adapter.close();
});

test("first-message navigation confirms submission even when the old preload response is lost", async () => {
  const ipcMain = new FakeIpcMain();
  const page = new EventEmitter();
  let url = "https://chatgpt.com/";
  page.id = 58;
  page.getURL = () => url;
  page.send = (channel, message) => {
    assert.equal(channel, COMMAND_CHANNEL);
    assert.equal(message.name, "send-prompt");
    queueMicrotask(() => {
      url = "https://chatgpt.com/c/first-message";
      page.emit("did-navigate-in-page", {}, url);
    });
    // Intentionally do not answer over RESPONSE_CHANNEL: the old page/preload
    // can disappear during ChatGPT's first-message navigation.
  };

  const adapter = new ElectronPreloadChatGPTPageAdapter({ ipcMain, requestTimeoutMs: 500 });
  const result = await adapter.sendPrompt(page, "planning prompt");
  assert.equal(result.ok, true);
  assert.equal(result.accepted, true);
  assert.equal(result.confirmed, true);
  assert.equal(result.method, "navigation");
  assert.equal(result.url, "https://chatgpt.com/c/first-message");
  adapter.close();
});

test("timed-out first-message send reconciles against the replacement preload after navigation", async () => {
  const ipcMain = new FakeIpcMain();
  const page = new EventEmitter();
  let url = "https://chatgpt.com/";
  page.id = 59;
  page.getURL = () => url;
  page.send = (channel, message) => {
    assert.equal(channel, COMMAND_CHANNEL);
    if (message.name === "send-prompt") {
      setTimeout(() => { url = "https://chatgpt.com/c/reconciled"; }, 25);
      return;
    }
    assert.equal(message.name, "status");
    queueMicrotask(() => respond(ipcMain, 59, message.requestId, {
      ok: true,
      availability: "generating",
      generating: true,
      composerOccupied: false,
      url
    }));
  };

  const adapter = new ElectronPreloadChatGPTPageAdapter({ ipcMain, requestTimeoutMs: 500 });
  const result = await adapter.sendPrompt(page, "planning prompt");
  assert.equal(result.ok, true);
  assert.equal(result.accepted, true);
  assert.equal(result.confirmed, true);
  assert.equal(result.method, "navigation-reconciled");
  assert.equal(result.recoveredFrom, "agent_preload_timeout");
  adapter.close();
});

test("staged prompt remains failed when no trusted input fallback is available", async () => {
  const ipcMain = new FakeIpcMain();
  const adapter = new ElectronPreloadChatGPTPageAdapter({ ipcMain, requestTimeoutMs: 1000 });
  const contents = webContents(57, (message) => {
    queueMicrotask(() => respond(ipcMain, 57, message.requestId, { ok: false, reason: "send_not_confirmed", promptStaged: true }));
  });
  const result = await adapter.sendPrompt(contents, "planning prompt");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "send_not_confirmed");
  assert.equal(result.promptStaged, true);
  adapter.close();
});

test("assistant snapshot is normalized, bounded and fingerprinted in the main process", async () => {
  const ipcMain = new FakeIpcMain();
  const adapter = new ElectronPreloadChatGPTPageAdapter({ ipcMain, requestTimeoutMs: 1000, maxAssistantBytes: 4096 });
  const contents = webContents(77, (message) => {
    queueMicrotask(() => respond(ipcMain, 77, message.requestId, {
      ok: true,
      text: "answer\u200b\n",
      messageCount: 3,
      pathname: "/c/abc",
      url: "https://chatgpt.com/c/abc",
      availability: "ready",
      generating: false
    }));
  });
  const snapshot = await adapter.readAssistantSnapshot(contents);
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.text, "answer");
  assert.equal(snapshot.messageCount, 3);
  assert.match(snapshot.fingerprint, /^[0-9a-f]+$/);
  adapter.close();
});

test("closing the page adapter resolves pending commands fail-closed", async () => {
  const ipcMain = new FakeIpcMain();
  const adapter = new ElectronPreloadChatGPTPageAdapter({ ipcMain, requestTimeoutMs: 5000 });
  const pending = adapter.ping(webContents(99));
  adapter.close();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.reason, "agent_preload_adapter_closed");
});
