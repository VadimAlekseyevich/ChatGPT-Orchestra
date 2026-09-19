"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { DesktopCompanionOnboarding } = require("../apps/desktop/renderer/desktop-companion-onboarding.js");

function fakeRoot() {
  return {
    innerHTML: "",
    addEventListener() {},
    removeEventListener() {}
  };
}

test("companion onboarding stays hidden outside companion runtime", async () => {
  const root = fakeRoot();
  const app = new DesktopCompanionOnboarding({
    rootElement: root,
    transport: { async runtimeMode() { return { ok: true, mode: "managed-browser", packaged: true }; } }
  });
  await app.refresh();
  assert.equal(root.innerHTML, "");
});

test("companion onboarding guides normal-browser login and prepares the packaged fallback", async () => {
  const root = fakeRoot();
  const calls = [];
  const transport = {
    async runtimeMode() { return { ok: true, mode: "companion", packaged: true }; },
    async prepareCompanionFallback() {
      calls.push("prepare");
      return { ok: true, extensionId: "abcdefghijklmnopabcdefghijklmnop", extensionDirectory: "C:/Orchestra/alpha-extension" };
    },
    async openCompanionExtensionFolder() { calls.push("folder"); return { ok: true }; },
    async openChatGPTExternal() { calls.push("chatgpt"); return { ok: true }; },
    async switchRuntime(mode) { calls.push(["switch", mode]); return { ok: true }; }
  };
  const app = new DesktopCompanionOnboarding({ rootElement: root, transport });
  await app.refresh();
  assert.match(root.innerHTML, /Chrome \/ Edge fallback/);
  assert.match(root.innerHTML, /Enable Desktop/);

  const prepared = await app.handleAction("prepare");
  assert.equal(prepared.ok, true);
  assert.match(root.innerHTML, /C:\/Orchestra\/alpha-extension/);

  await app.handleAction("open-folder");
  await app.handleAction("open-chatgpt");
  await app.handleAction("managed");
  assert.deepEqual(calls, ["prepare", "folder", "chatgpt", ["switch", "managed-browser"]]);
});
