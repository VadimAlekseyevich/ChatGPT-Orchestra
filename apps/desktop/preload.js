"use strict";

const { contextBridge, ipcRenderer } = require("electron");
const IPC_QUERY_CHANNEL = "orchestra:query";
const IPC_EXECUTE_CHANNEL = "orchestra:execute";
const IPC_SELECT_REPOSITORY_DIRECTORY = "orchestra:select-repository-directory";
const IPC_RESTART_APPLICATION = "orchestra:restart-application";
const IPC_RUNTIME_MODE = "orchestra:runtime-mode";
const IPC_SWITCH_RUNTIME = "orchestra:switch-runtime";
const IPC_PREPARE_COMPANION_FALLBACK = "orchestra:prepare-companion-fallback";
const IPC_OPEN_COMPANION_EXTENSION_FOLDER = "orchestra:open-companion-extension-folder";
const IPC_OPEN_CHATGPT_EXTERNAL = "orchestra:open-chatgpt-external";

function clone(value) {
  if (value === undefined) return {};
  return JSON.parse(JSON.stringify(value));
}

contextBridge.exposeInMainWorld("orchestraDesktop", Object.freeze({
  query(name, payload = {}) {
    return ipcRenderer.invoke(IPC_QUERY_CHANNEL, { name: String(name || ""), payload: clone(payload) });
  },
  execute(name, payload = {}) {
    return ipcRenderer.invoke(IPC_EXECUTE_CHANNEL, { name: String(name || ""), payload: clone(payload) });
  },
  selectRepositoryDirectory() {
    return ipcRenderer.invoke(IPC_SELECT_REPOSITORY_DIRECTORY);
  },
  restartApplication() {
    return ipcRenderer.invoke(IPC_RESTART_APPLICATION);
  },
  runtimeMode() {
    return ipcRenderer.invoke(IPC_RUNTIME_MODE);
  },
  switchRuntime(mode) {
    return ipcRenderer.invoke(IPC_SWITCH_RUNTIME, String(mode || ""));
  },
  prepareCompanionFallback() {
    return ipcRenderer.invoke(IPC_PREPARE_COMPANION_FALLBACK);
  },
  openCompanionExtensionFolder() {
    return ipcRenderer.invoke(IPC_OPEN_COMPANION_EXTENSION_FOLDER);
  },
  openChatGPTExternal() {
    return ipcRenderer.invoke(IPC_OPEN_CHATGPT_EXTERNAL);
  }
}));

module.exports = {
  IPC_QUERY_CHANNEL,
  IPC_EXECUTE_CHANNEL,
  IPC_SELECT_REPOSITORY_DIRECTORY,
  IPC_RESTART_APPLICATION,
  IPC_RUNTIME_MODE,
  IPC_SWITCH_RUNTIME,
  IPC_PREPARE_COMPANION_FALLBACK,
  IPC_OPEN_COMPANION_EXTENSION_FOLDER,
  IPC_OPEN_CHATGPT_EXTERNAL
};
