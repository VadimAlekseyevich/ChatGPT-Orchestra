"use strict";

const path = require("node:path");
const { app, BrowserWindow, ipcMain, shell } = require("electron");
const { createDesktopHost } = require("./desktop-host.js");
const { createNativeCompanionDesktopHost } = require("./companion-desktop-host.js");
const { DesktopIpcRouter, registerElectronIpc } = require("./ipc-router.js");

let host = null;
let unregisterIpc = null;
let mainWindow = null;

function companionRequested() {
  return process.argv.includes("--companion") || process.env.ORCHESTRA_COMPANION === "1";
}

async function createMainWindow() {
  const dataDirectory = app.getPath("userData");
  host = companionRequested()
    ? await createNativeCompanionDesktopHost({ dataDirectory })
    : await createDesktopHost({ dataDirectory });
  unregisterIpc = registerElectronIpc({ ipcMain, router: new DesktopIpcRouter({ host }) });

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 640,
    title: companionRequested() ? "ChatGPT Orchestra · Companion" : "ChatGPT Orchestra",
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

module.exports = { companionRequested };
