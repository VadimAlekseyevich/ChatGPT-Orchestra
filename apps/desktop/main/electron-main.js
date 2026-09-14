"use strict";

const CompanionNativeHost = require("../../companion/native-host.js");
const NativeHostRegistration = require("../../companion/native-host-registration.js");
const { resolveDesktopDataDirectory } = require("./app-data.js");
const {
  RUNTIME_MODES,
  companionRequested,
  managedBrowserRequested,
  resolveDesktopRuntimeMode
} = require("./desktop-runtime-mode.js");

function nativeMessagingRequested(argv = process.argv.slice(1)) {
  return CompanionNativeHost.isNativeMessagingLaunch(argv);
}

function optionValue(argv, name) {
  const prefix = `--${name}=`;
  const raw = (argv || []).find((item) => String(item || "").startsWith(prefix));
  return raw ? String(raw).slice(prefix.length) : null;
}

function nativeHostRegistrationRequest(argv = process.argv.slice(1)) {
  const extensionId = optionValue(argv, "register-native-host");
  const unregister = (argv || []).includes("--unregister-native-host");
  if (!extensionId && !unregister) return null;
  const browsers = String(optionValue(argv, "native-host-browsers") || "edge").split(",").map((item) => item.trim()).filter(Boolean);
  return extensionId ? { action: "register", extensionId, browsers } : { action: "unregister", browsers };
}

function orchestraDataDirectory(env = process.env) {
  return env.ORCHESTRA_DATA_DIR || resolveDesktopDataDirectory();
}

async function runNativeMessagingHost() {
  return CompanionNativeHost.main();
}

function runNativeHostRegistration(request, { executable = process.execPath, dataDirectory = orchestraDataDirectory() } = {}) {
  if (!request) throw new TypeError("native_host_registration_request_required");
  if (request.action === "register") {
    return NativeHostRegistration.registerNativeHost({
      extensionId: request.extensionId,
      hostPath: executable,
      browsers: request.browsers,
      dataDirectory
    });
  }
  if (request.action === "unregister") {
    return NativeHostRegistration.unregisterNativeHost({
      browsers: request.browsers,
      dataDirectory
    });
  }
  throw new TypeError("native_host_registration_action_invalid");
}

const registrationRequest = nativeHostRegistrationRequest();
if (registrationRequest) {
  Promise.resolve()
    .then(() => runNativeHostRegistration(registrationRequest))
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${error?.stack || error?.message || error}\n`);
      process.exitCode = 1;
    });
} else if (nativeMessagingRequested()) {
  runNativeMessagingHost().catch((error) => {
    process.stderr.write(`${error?.stack || error?.message || error}\n`);
    process.exitCode = 1;
  });
} else {
  const path = require("node:path");
  const { app, BrowserWindow, ipcMain, shell } = require("electron");
  const { createDesktopHost } = require("./desktop-host.js");
  const { createNativeCompanionDesktopHost } = require("./companion-desktop-host.js");
  const { createManagedBrowserDesktopHost } = require("./managed-browser-desktop-host.js");
  const { DesktopIpcRouter, registerElectronIpc } = require("./ipc-router.js");

  let host = null;
  let unregisterIpc = null;
  let mainWindow = null;

  async function createMainWindow() {
    const dataDirectory = orchestraDataDirectory();
    const runtimeMode = resolveDesktopRuntimeMode();
    if (runtimeMode === RUNTIME_MODES.COMPANION) host = await createNativeCompanionDesktopHost({ dataDirectory });
    else if (runtimeMode === RUNTIME_MODES.MANAGED_BROWSER) host = await createManagedBrowserDesktopHost({ dataDirectory });
    else host = await createDesktopHost({ dataDirectory });
    unregisterIpc = registerElectronIpc({ ipcMain, router: new DesktopIpcRouter({ host }) });

    const title = runtimeMode === RUNTIME_MODES.COMPANION
      ? "ChatGPT Orchestra · Companion"
      : runtimeMode === RUNTIME_MODES.MANAGED_BROWSER
        ? "ChatGPT Orchestra · Managed Browser"
        : "ChatGPT Orchestra";

    mainWindow = new BrowserWindow({
      width: 1280,
      height: 860,
      minWidth: 900,
      minHeight: 640,
      title,
      webPreferences: {
        preload: path.join(__dirname, "..", "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
      return { action: "deny" };
    });
    mainWindow.webContents.on("will-navigate", (event, url) => {
      if (!url.startsWith("file://")) event.preventDefault();
    });
    await mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
    mainWindow.on("closed", () => { mainWindow = null; });
  }

  app.whenReady().then(createMainWindow).catch((error) => {
    console.error("[ChatGPT Orchestra] desktop_boot_failed", error);
    app.exit(1);
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow().catch((error) => console.error("[ChatGPT Orchestra] desktop_window_failed", error));
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", () => {
    unregisterIpc?.();
    unregisterIpc = null;
    host?.close?.().catch((error) => console.warn("[ChatGPT Orchestra] desktop_close_failed", error));
    host = null;
  });
}

module.exports = {
  companionRequested,
  managedBrowserRequested,
  resolveDesktopRuntimeMode,
  nativeMessagingRequested,
  nativeHostRegistrationRequest,
  orchestraDataDirectory,
  runNativeMessagingHost,
  runNativeHostRegistration
};
