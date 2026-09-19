"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const NativeHostRegistration = require("../../companion/native-host-registration.js");

const FALLBACK_EXTENSION_ID = "eanhdlabfjbnhdinbkaigkmhknhofbjl";

function extensionIdFromManifestKey(key) {
  const raw = Buffer.from(String(key || "").replace(/\s+/g, ""), "base64");
  if (!raw.length) throw new Error("companion_fallback_extension_key_invalid");
  const digest = crypto.createHash("sha256").update(raw).digest().subarray(0, 16);
  let id = "";
  for (const byte of digest) {
    id += String.fromCharCode(97 + (byte >> 4));
    id += String.fromCharCode(97 + (byte & 15));
  }
  return id;
}

function resolveCompanionExtensionDirectory({ isPackaged = false, resourcesPath = "", appPath = "" } = {}) {
  if (isPackaged) return path.resolve(String(resourcesPath || ""), "alpha-extension");
  return path.resolve(String(appPath || ""), "dist", "alpha-extension");
}

function readFallbackManifest(extensionDirectory) {
  const manifestPath = path.join(path.resolve(String(extensionDirectory || "")), "manifest.json");
  if (!fs.existsSync(manifestPath) || !fs.statSync(manifestPath).isFile()) {
    throw new Error("companion_fallback_extension_missing");
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const extensionId = extensionIdFromManifestKey(manifest.key);
  if (extensionId !== FALLBACK_EXTENSION_ID) throw new Error("companion_fallback_extension_id_mismatch");
  return { manifest, manifestPath, extensionId };
}

function prepareCompanionFallback({
  extensionDirectory,
  dataDirectory,
  hostPath,
  browsers = ["edge", "chrome"],
  registerNativeHost = NativeHostRegistration.registerNativeHost
} = {}) {
  const directory = path.resolve(String(extensionDirectory || ""));
  const executable = path.resolve(String(hostPath || ""));
  if (!fs.existsSync(executable) || !fs.statSync(executable).isFile()) {
    throw new Error("companion_fallback_host_missing");
  }
  const { extensionId } = readFallbackManifest(directory);
  const selectedBrowsers = [...new Set((browsers || []).map((item) => String(item || "").trim()).filter(Boolean))];
  if (!selectedBrowsers.length) throw new Error("companion_fallback_browsers_required");
  const registration = registerNativeHost({
    extensionId,
    hostPath: executable,
    browsers: selectedBrowsers,
    dataDirectory
  });
  return {
    ok: true,
    extensionId,
    extensionDirectory: directory,
    browsers: selectedBrowsers,
    registration
  };
}

module.exports = {
  FALLBACK_EXTENSION_ID,
  extensionIdFromManifestKey,
  resolveCompanionExtensionDirectory,
  readFallbackManifest,
  prepareCompanionFallback
};
