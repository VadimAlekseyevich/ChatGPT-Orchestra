"use strict";

const { contextBridge, ipcRenderer } = require("electron");
const IPC_QUERY_CHANNEL = "orchestra:query";
const IPC_EXECUTE_CHANNEL = "orchestra:execute";
const IPC_SELECT_REPOSITORY_DIRECTORY = "orchestra:select-repository-directory";

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
  }
}));

module.exports = {
  IPC_QUERY_CHANNEL,
  IPC_EXECUTE_CHANNEL,
  IPC_SELECT_REPOSITORY_DIRECTORY
};
