const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  validateExtensionId,
  createNativeHostManifest,
  manifestDirectoryForBrowser,
  windowsRegistryKey,
  registerNativeHost,
  unregisterNativeHost
} = require("../apps/companion/native-host-registration.js");
const { isNativeMessagingLaunch, nativeMessagingOrigin } = require("../apps/companion/native-host.js");

const EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop";

function tempExecutable(root, name = "ChatGPT Orchestra.exe") {
  const filename = path.join(root, name);
  fs.writeFileSync(filename, "fixture");
  return filename;
}

test("extension ids and generated native-host origins are fail-closed", () => {
  assert.equal(validateExtensionId(EXTENSION_ID), EXTENSION_ID);
  assert.throws(() => validateExtensionId("not-an-extension"), /invalid_extension_id/);

  const manifest = createNativeHostManifest({ hostPath: "/opt/orchestra/ChatGPT Orchestra", extensionId: EXTENSION_ID });
  assert.equal(manifest.name, "com.chatgptorchestra.companion");
  assert.equal(manifest.type, "stdio");
  assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${EXTENSION_ID}/`]);
});

test("native relay launch is detected from Chrome/Edge origin argument", () => {
  assert.equal(nativeMessagingOrigin([`chrome-extension://${EXTENSION_ID}/`, "123"]), `chrome-extension://${EXTENSION_ID}/`);
  assert.equal(isNativeMessagingLaunch([`chrome-extension://${EXTENSION_ID}/`, "123"]), true);
  assert.equal(isNativeMessagingLaunch(["--native-messaging-host"]), true);
  assert.equal(isNativeMessagingLaunch(["--companion"]), false);
  assert.equal(isNativeMessagingLaunch(["chrome-extension://INVALID/"]), false);
});

test("browser manifest directories are deterministic on Linux and macOS", () => {
  assert.equal(
    manifestDirectoryForBrowser({ platform: "linux", browser: "edge", home: "/home/u", env: { XDG_CONFIG_HOME: "/cfg" } }),
    path.join("/cfg", "microsoft-edge", "NativeMessagingHosts")
  );
  assert.equal(
    manifestDirectoryForBrowser({ platform: "darwin", browser: "chrome", home: "/Users/u", env: {} }),
    path.join("/Users/u", "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts")
  );
  assert.match(windowsRegistryKey("edge"), /Microsoft\\Edge\\NativeMessagingHosts\\com\.chatgptorchestra\.companion$/);
});

test("Windows registration writes one shared manifest and uses reg.exe argv without shell", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-native-win-"));
  const hostPath = tempExecutable(root);
  const calls = [];
  const execFileSync = (file, args, options) => calls.push({ file, args, options });

  const result = registerNativeHost({
    extensionId: EXTENSION_ID,
    hostPath,
    browsers: ["edge", "chrome"],
    platform: "win32",
    dataDirectory: path.join(root, "data"),
    execFileSync
  });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.file, "reg.exe");
    assert.equal(call.args[0], "ADD");
    assert.equal(call.args.includes("/f"), true);
    assert.equal(Object.prototype.hasOwnProperty.call(call.options, "shell"), false);
  }
  const manifest = JSON.parse(fs.readFileSync(result.manifestPath, "utf8"));
  assert.equal(manifest.path, path.resolve(hostPath));
  assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${EXTENSION_ID}/`]);

  const removed = unregisterNativeHost({
    browsers: ["edge", "chrome"],
    platform: "win32",
    dataDirectory: path.join(root, "data"),
    execFileSync
  });
  assert.equal(removed.ok, true);
  assert.equal(calls.filter((call) => call.args[0] === "DELETE").length, 2);
});

test("Linux registration writes browser-specific manifests with the packaged host path", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-native-linux-"));
  const hostPath = tempExecutable(root, "chatgpt-orchestra");
  const config = path.join(root, "config");
  const result = registerNativeHost({
    extensionId: EXTENSION_ID,
    hostPath,
    browsers: ["edge", "chromium"],
    platform: "linux",
    home: path.join(root, "home"),
    env: { XDG_CONFIG_HOME: config },
    dataDirectory: path.join(root, "data")
  });

  assert.equal(result.registered.length, 2);
  const expected = [
    path.join(config, "microsoft-edge", "NativeMessagingHosts", "com.chatgptorchestra.companion.json"),
    path.join(config, "chromium", "NativeMessagingHosts", "com.chatgptorchestra.companion.json")
  ];
  for (const filename of expected) {
    const manifest = JSON.parse(fs.readFileSync(filename, "utf8"));
    assert.equal(manifest.path, path.resolve(hostPath));
    assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${EXTENSION_ID}/`]);
  }
});

test("electron main checks native-host mode before loading Electron GUI APIs", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../apps/desktop/main/electron-main.js"), "utf8");
  const branchIndex = source.indexOf("if (nativeMessagingRequested())");
  const electronIndex = source.indexOf('require("electron")');
  assert.ok(branchIndex >= 0);
  assert.ok(electronIndex > branchIndex);
});
