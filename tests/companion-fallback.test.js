"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  FALLBACK_EXTENSION_ID,
  extensionIdFromManifestKey,
  resolveCompanionExtensionDirectory,
  prepareCompanionFallback
} = require("../apps/desktop/main/companion-fallback.js");

const MANIFEST_KEY = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA1xrszfXmsF6tsXSRrxmFB6/ZF0NDpuhyq8x9KBO+9/JH5xAw1yNwszfjamWZ2Z2IICLQBpP/R0vlEkJ9YdFDvD18M4SuHLlE0oZjXUHfTLimP6AiHrWBm/P5hUVoloJzj2/PUIrxIRliZSIuDnjM67CkZRTvPQoIfJs1faZoodF4h7jBWGxul6Bnq1D/kSAyiSQHBne4LaVE/FisQ/AgtdeKBbKyLXXpHFijHxSY53RCi8S6xYRRs+GWEbKdii/qt3tcVYGXt5m8ahZN+MvfhXBDJ2/lDmzxW13Y1Ut/kkjEjncParRVMRH+WwcpBi8plrU+0sMUnqcsX/MD6IAyMwIDAQAB";

test("fallback extension manifest key produces the fixed Chrome/Edge extension id", () => {
  assert.equal(extensionIdFromManifestKey(MANIFEST_KEY), FALLBACK_EXTENSION_ID);
});

test("fallback extension directory resolves outside app.asar for packaged candidates", () => {
  assert.equal(
    resolveCompanionExtensionDirectory({ isPackaged: true, resourcesPath: "C:/Program Files/Orchestra/resources", appPath: "ignored" }),
    path.resolve("C:/Program Files/Orchestra/resources", "alpha-extension")
  );
  assert.equal(
    resolveCompanionExtensionDirectory({ isPackaged: false, appPath: "C:/repo" }),
    path.resolve("C:/repo", "dist", "alpha-extension")
  );
});

test("preparing companion fallback validates the stable extension id and registers only explicit browsers", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-companion-fallback-"));
  const extensionDirectory = path.join(root, "extension");
  const hostPath = path.join(root, process.platform === "win32" ? "ChatGPT Orchestra.exe" : "chatgpt-orchestra");
  fs.mkdirSync(extensionDirectory, { recursive: true });
  fs.writeFileSync(path.join(extensionDirectory, "manifest.json"), JSON.stringify({ manifest_version: 3, key: MANIFEST_KEY }), "utf8");
  fs.writeFileSync(hostPath, "host", "utf8");

  const calls = [];
  const result = prepareCompanionFallback({
    extensionDirectory,
    dataDirectory: path.join(root, "data"),
    hostPath,
    browsers: ["edge", "chrome", "edge"],
    registerNativeHost(options) {
      calls.push(options);
      return { ok: true };
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.extensionId, FALLBACK_EXTENSION_ID);
  assert.deepEqual(result.browsers, ["edge", "chrome"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].extensionId, FALLBACK_EXTENSION_ID);
  assert.equal(calls[0].hostPath, path.resolve(hostPath));
  assert.deepEqual(calls[0].browsers, ["edge", "chrome"]);
});

test("preparing fallback fails closed when the packaged extension is missing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orchestra-companion-fallback-missing-"));
  const hostPath = path.join(root, "host.exe");
  fs.writeFileSync(hostPath, "host", "utf8");
  assert.throws(() => prepareCompanionFallback({
    extensionDirectory: path.join(root, "missing"),
    dataDirectory: path.join(root, "data"),
    hostPath,
    registerNativeHost() { throw new Error("must_not_register"); }
  }), /companion_fallback_extension_missing/);
});
