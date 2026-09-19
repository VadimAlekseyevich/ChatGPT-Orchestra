"use strict";

const CompanionNativeHost = require("../../companion/native-host.js");
const NativeHostRegistration = require("../../companion/native-host-registration.js");
const { resolveDesktopDataDirectory } = require("./app-data.js");
const {
  RUNTIME_MODES,
  companionRequested,
  managedBrowserRequested,
  runtimeRelaunchArgs,
  resolveDesktopRuntimeMode
} = require("./desktop-runtime-mode.js");

const IPC_SELECT_REPOSITORY_DIRECTORY = "orchestra:select-repository-directory";
const IPC_RESTART_APPLICATION = "orchestra:restart-application";
const IPC_RUNTIME_MODE = "orchestra:runtime-mode";
const IPC_SWITCH_RUNTIME = "orchestra:switch-runtime";
const IPC_PREPARE_COMPANION_FALLBACK = "orchestra:prepare-companion-fallback";
const IPC_OPEN_COMPANION_EXTENSION_FOLDER = "orchestra:open-companion-extension-folder";
const IPC_OPEN_CHATGPT_EXTERNAL = "orchestra:open-chatgpt-external";

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
  const { app, BrowserWindow, ipcMain, shell, dialog } = require("electron");
  const { createDesktopHost } = require("./desktop-host.js");
  const { createNativeCompanionDesktopHost } = require("./companion-desktop-host.js");
  const { createManagedBrowserDesktopHost } = require("./managed-browser-desktop-host.js");
  const { DesktopIpcRouter, registerElectronIpc } = require("./ipc-router.js");
  const { revealDesktopMainWindow } = require("./desktop-window-policy.js");
  const { resolveCompanionExtensionDirectory, prepareCompanionFallback } = require("./companion-fallback.js");

  let host = null;
  let unregisterIpc = null;
  let mainWindow = null;

  function registerDesktopShellIpc({ runtimeMode, dataDirectory }) {
    for (const channel of [
      IPC_SELECT_REPOSITORY_DIRECTORY,
      IPC_RESTART_APPLICATION,
      IPC_RUNTIME_MODE,
      IPC_SWITCH_RUNTIME,
      IPC_PREPARE_COMPANION_FALLBACK,
      IPC_OPEN_COMPANION_EXTENSION_FOLDER,
      IPC_OPEN_CHATGPT_EXTERNAL
    ]) ipcMain.removeHandler(channel);
    ipcMain.handle(IPC_SELECT_REPOSITORY_DIRECTORY, async () => {
      const result = await dialog.showOpenDialog(mainWindow || undefined, {
        title: "Open local Git repository",
        properties: ["openDirectory"]
      });
      const selectedPath = result?.filePaths?.[0] || null;
      if (result?.canceled || !selectedPath) return { ok: false, cancelled: true, path: null };
      return { ok: true, cancelled: false, path: selectedPath };
    });
    ipcMain.handle(IPC_RESTART_APPLICATION, async () => {
      setTimeout(() => {
        try {
          app.relaunch();
          app.quit();
        } catch (error) {
          console.error("[ChatGPT Orchestra] desktop_restart_failed", error);
          app.exit(1);
        }
      }, 75);
      return { ok: true, restarting: true };
    });
    ipcMain.handle(IPC_RUNTIME_MODE, async () => ({
      ok: true,
      mode: runtimeMode,
      packaged: Boolean(app.isPackaged)
    }));
    ipcMain.handle(IPC_SWITCH_RUNTIME, async (_event, requestedMode) => {
      const mode = String(requestedMode || "");
      if (![RUNTIME_MODES.COMPANION, RUNTIME_MODES.MANAGED_BROWSER].includes(mode)) {
        return { ok: false, reason: "desktop_runtime_mode_invalid" };
      }
      const args = runtimeRelaunchArgs(process.argv.slice(1), mode);
      delete process.env.ORCHESTRA_COMPANION;
      delete process.env.ORCHESTRA_MANAGED_BROWSER;
      delete process.env.ORCHESTRA_DESKTOP_SHELL;
      setTimeout(() => {
        try {
          app.relaunch({ args });
          app.quit();
        } catch (error) {
          console.error("[ChatGPT Orchestra] desktop_runtime_switch_failed", error);
          app.exit(1);
        }
      }, 75);
      return { ok: true, restarting: true, mode };
    });
    ipcMain.handle(IPC_PREPARE_COMPANION_FALLBACK, async () => {
      const extensionDirectory = resolveCompanionExtensionDirectory({
        isPackaged: Boolean(app.isPackaged),
        resourcesPath: process.resourcesPath,
        appPath: app.getAppPath()
      });
      if (!app.isPackaged) {
        return { ok: false, reason: "companion_fallback_requires_packaged_runtime", extensionDirectory };
      }
      try {
        return prepareCompanionFallback({
          extensionDirectory,
          dataDirectory,
          hostPath: process.execPath,
          browsers: ["edge", "chrome"]
        });
      } catch (error) {
        const reason = String(error?.message || error || "companion_fallback_prepare_failed");
        return { ok: false, reason: /^[a-z0-9_:-]+$/i.test(reason) ? reason : "companion_fallback_prepare_failed" };
      }
    });
    ipcMain.handle(IPC_OPEN_COMPANION_EXTENSION_FOLDER, async () => {
      const extensionDirectory = resolveCompanionExtensionDirectory({
        isPackaged: Boolean(app.isPackaged),
        resourcesPath: process.resourcesPath,
        appPath: app.getAppPath()
      });
      const error = await shell.openPath(extensionDirectory);
      return error ? { ok: false, reason: "companion_fallback_extension_open_failed" } : { ok: true, extensionDirectory };
    });
    ipcMain.handle(IPC_OPEN_CHATGPT_EXTERNAL, async () => {
      try {
        await shell.openExternal("https://chatgpt.com/");
        return { ok: true };
      } catch (_) {
        return { ok: false, reason: "external_chatgpt_open_failed" };
      }
    });
  }

  async function createMainWindow() {
    const dataDirectory = orchestraDataDirectory();
    const runtimeMode = resolveDesktopRuntimeMode();
    if (runtimeMode === RUNTIME_MODES.COMPANION) host = await createNativeCompanionDesktopHost({ dataDirectory });
    else if (runtimeMode === RUNTIME_MODES.MANAGED_BROWSER) host = await createManagedBrowserDesktopHost({ dataDirectory });
    else host = await createDesktopHost({ dataDirectory });
    unregisterIpc = registerElectronIpc({ ipcMain, router: new DesktopIpcRouter({ host }) });
    registerDesktopShellIpc({ runtimeMode, dataDirectory });

    const title = runtimeMode === RUNTIME_MODES.COMPANION
      ? "ChatGPT Orchestra · Companion"
      : runtimeMode === RUNTIME_MODES.MANAGED_BROWSER
        ? "ChatGPT Orchestra · Managed Browser"
        : "ChatGPT Orchestra";

    mainWindow = new BrowserWindow({
      show: false,
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
    revealDesktopMainWindow(mainWindow, { preserveExistingFocus: runtimeMode === RUNTIME_MODES.MANAGED_BROWSER });
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
    for (const channel of [
      IPC_SELECT_REPOSITORY_DIRECTORY,
      IPC_RESTART_APPLICATION,
      IPC_RUNTIME_MODE,
      IPC_SWITCH_RUNTIME,
      IPC_PREPARE_COMPANION_FALLBACK,
      IPC_OPEN_COMPANION_EXTENSION_FOLDER,
      IPC_OPEN_CHATGPT_EXTERNAL
    ]) ipcMain.removeHandler(channel);
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
  runNativeHostRegistration,
  IPC_SELECT_REPOSITORY_DIRECTORY,
  IPC_RESTART_APPLICATION,
  IPC_RUNTIME_MODE,
  IPC_SWITCH_RUNTIME,
  IPC_PREPARE_COMPANION_FALLBACK,
  IPC_OPEN_COMPANION_EXTENSION_FOLDER,
  IPC_OPEN_CHATGPT_EXTERNAL
};
