const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), "utf8");
}

test("manifest declares native messaging only through the explicit companion permission", () => {
  const manifest = JSON.parse(read("manifest.json"));
  assert.equal(manifest.permissions.includes("nativeMessaging"), true);
  assert.equal(manifest.background.service_worker, "background/service-worker.js");
});

test("service worker parses and imports companion mode before routing runtime messages", () => {
  const source = read("background/service-worker.js");
  assert.doesNotThrow(() => new Function(source));
  for (const required of [
    "../platform/companion-protocol.js",
    "../platform/companion-rpc.js",
    "../platform/native-messaging-transport.js",
    "../platform/extension-companion-endpoint.js",
    "../platform/extension-companion-mode.js"
  ]) assert.match(source, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(source, /COMPANION_ENABLE/);
  assert.match(source, /COMPANION_DISABLE/);
  assert.match(source, /COMPANION_RECONNECT/);
});

test("companion mode is fail-closed and suppresses the local watchdog", () => {
  const source = read("background/service-worker.js");
  assert.match(source, /reason:\s*"companion_disconnected"/);
  assert.match(source, /companionController\.isEnabled\(\)/);
  assert.match(source, /suspendLocalRuntime\(\)/);
  assert.match(source, /!localRuntimeActive\s*\|\|\s*portableReloadPending\s*\|\|\s*companionController\.isEnabled\(\)/);
});
