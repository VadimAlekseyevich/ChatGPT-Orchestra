"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const childProcess = require("node:child_process");
const { DEFAULT_HOST_NAME } = require("../../platform/native-messaging-transport.js");
const { ensureDesktopPaths } = require("../desktop/main/app-data.js");

const EXTENSION_ID_PATTERN = /^[a-p]{32}$/;
const SUPPORTED_BROWSERS = Object.freeze(["edge", "chrome", "chromium"]);

function validateExtensionId(value) {
  const id = String(value || "").trim().toLowerCase();
  if (!EXTENSION_ID_PATTERN.test(id)) throw new TypeError("invalid_extension_id");
  return id;
}

function validateHostPath(value, { exists = fs.existsSync, stat = fs.statSync } = {}) {
  const raw = String(value || "").trim();
  if (!raw) throw new TypeError("native_host_path_invalid");
  const hostPath = path.resolve(raw);
  if (!exists(hostPath)) throw new TypeError("native_host_path_invalid");
  let info;
  try { info = stat(hostPath); } catch (_) { throw new TypeError("native_host_path_invalid"); }
  if (!info?.isFile?.()) throw new TypeError("native_host_path_invalid");
  return hostPath;
}

function normalizeBrowsers(input = ["edge"]) {
  const list = Array.isArray(input) ? input : String(input || "edge").split(",");
  const browsers = [...new Set(list.map((item) => String(item || "").trim().toLowerCase()).filter(Boolean))];
  if (!browsers.length || browsers.some((browser) => !SUPPORTED_BROWSERS.includes(browser))) throw new TypeError("native_host_browser_invalid");
  return browsers;
}

function createNativeHostManifest({ hostPath, extensionId, hostName = DEFAULT_HOST_NAME } = {}) {
  return {
    name: String(hostName || DEFAULT_HOST_NAME),
    description: "Authenticated ChatGPT Orchestra extension companion relay",
    path: path.resolve(hostPath),
    type: "stdio",
    allowed_origins: [`chrome-extension://${validateExtensionId(extensionId)}/`]
  };
}

function manifestDirectoryForBrowser({ platform = process.platform, browser, home = os.homedir(), env = process.env } = {}) {
  const name = String(browser || "").toLowerCase();
  if (platform === "darwin") {
    const roots = {
      edge: path.join(home, "Library", "Application Support", "Microsoft Edge", "NativeMessagingHosts"),
      chrome: path.join(home, "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts"),
      chromium: path.join(home, "Library", "Application Support", "Chromium", "NativeMessagingHosts")
    };
    return roots[name] || null;
  }
  if (platform === "linux") {
    const configHome = env.XDG_CONFIG_HOME || path.join(home, ".config");
    const roots = {
      edge: path.join(configHome, "microsoft-edge", "NativeMessagingHosts"),
      chrome: path.join(configHome, "google-chrome", "NativeMessagingHosts"),
      chromium: path.join(configHome, "chromium", "NativeMessagingHosts")
    };
    return roots[name] || null;
  }
  return null;
}

function windowsRegistryKey(browser, hostName = DEFAULT_HOST_NAME) {
  const bases = {
    edge: "HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts",
    chrome: "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts",
    chromium: "HKCU\\Software\\Chromium\\NativeMessagingHosts"
  };
  const base = bases[String(browser || "").toLowerCase()];
  return base ? `${base}\\${hostName}` : null;
}

function writeManifest(filename, manifest) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try { fs.chmodSync(filename, 0o600); } catch (_) {}
}

function registerNativeHost({
  extensionId,
  hostPath,
  browsers = ["edge"],
  platform = process.platform,
  home = os.homedir(),
  env = process.env,
  dataDirectory = null,
  execFileSync = childProcess.execFileSync,
  hostName = DEFAULT_HOST_NAME
} = {}) {
  const id = validateExtensionId(extensionId);
  const executable = validateHostPath(hostPath);
  const targets = normalizeBrowsers(browsers);
  const paths = ensureDesktopPaths({ dataDirectory });
  const manifestPath = paths.companionNativeHostManifestFile;
  const manifest = createNativeHostManifest({ hostPath: executable, extensionId: id, hostName });
  writeManifest(manifestPath, manifest);

  const registered = [];
  if (platform === "win32") {
    for (const browser of targets) {
      const key = windowsRegistryKey(browser, hostName);
      if (!key) throw new Error(`native_host_browser_unsupported:${browser}`);
      execFileSync("reg.exe", ["ADD", key, "/ve", "/t", "REG_SZ", "/d", manifestPath, "/f"], { windowsHide: true, stdio: "pipe" });
      registered.push({ browser, kind: "registry", key, manifestPath });
    }
  } else if (platform === "linux" || platform === "darwin") {
    for (const browser of targets) {
      const directory = manifestDirectoryForBrowser({ platform, browser, home, env });
      if (!directory) throw new Error(`native_host_browser_unsupported:${browser}`);
      const targetManifest = path.join(directory, `${hostName}.json`);
      writeManifest(targetManifest, manifest);
      registered.push({ browser, kind: "manifest", manifestPath: targetManifest });
    }
  } else {
    throw new Error(`native_host_platform_unsupported:${platform}`);
  }

  return { ok: true, extensionId: id, hostPath: executable, manifestPath, registered };
}

function unregisterNativeHost({
  browsers = ["edge"],
  platform = process.platform,
  home = os.homedir(),
  env = process.env,
  dataDirectory = null,
  execFileSync = childProcess.execFileSync,
  hostName = DEFAULT_HOST_NAME
} = {}) {
  const targets = normalizeBrowsers(browsers);
  const paths = ensureDesktopPaths({ dataDirectory });
  const removed = [];
  if (platform === "win32") {
    for (const browser of targets) {
      const key = windowsRegistryKey(browser, hostName);
      try { execFileSync("reg.exe", ["DELETE", key, "/f"], { windowsHide: true, stdio: "pipe" }); }
      catch (error) {
        if (!String(error?.stderr || error?.message || "").match(/unable to find|not found/i)) throw error;
      }
      removed.push({ browser, kind: "registry", key });
    }
  } else if (platform === "linux" || platform === "darwin") {
    for (const browser of targets) {
      const directory = manifestDirectoryForBrowser({ platform, browser, home, env });
      const targetManifest = path.join(directory, `${hostName}.json`);
      try { fs.unlinkSync(targetManifest); } catch (error) { if (error?.code !== "ENOENT") throw error; }
      removed.push({ browser, kind: "manifest", manifestPath: targetManifest });
    }
  } else {
    throw new Error(`native_host_platform_unsupported:${platform}`);
  }
  try { fs.unlinkSync(paths.companionNativeHostManifestFile); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  return { ok: true, removed };
}

module.exports = {
  EXTENSION_ID_PATTERN,
  SUPPORTED_BROWSERS,
  validateExtensionId,
  validateHostPath,
  normalizeBrowsers,
  createNativeHostManifest,
  manifestDirectoryForBrowser,
  windowsRegistryKey,
  registerNativeHost,
  unregisterNativeHost
};
